import { Router, type Request, type Response } from "express";
import { identityFor } from "../../lib/ids.js";
import { recordUserAudit, listAudit } from "../audit/service.js";
import { isAuditAction } from "../../lib/auditActions.js";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rateLimit.js";
import { newProtocolId } from "../../lib/ids.js";
import { verifyPassword } from "../../lib/auth.js";
import { publicUser } from "../../lib/serialize.js";
import {
  ALL_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  Permission,
  combinePermissions,
  hasPermission,
} from "../../lib/permissions.js";
import { emitSyncEvent } from "../sync/events.js";
import { closeVoiceRooms, disconnectFromVoice, disconnectWhoCannotConnect, getVoiceBackend, voiceChannelIdsOf, voiceStateOf } from "../voice/service.js";
import { getMemberPermissions } from "./memberPermissions.js";
import { deleteUnreferencedMedia } from "./communityMedia.js";
import { isIconUrl, sanitizeIconColor, sanitizeIconText } from "../../lib/communityIcon.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { FederationProxyError, proxyToHomeServer } from "../../lib/federation/proxy.js";
import { getRemoteCommunityDomains } from "../messages/federationRelay.js";
import { INVITE_CODE_PATTERN, createInviteSchema, inviteJoinReference, parseJoinReference } from "../../lib/invites.js";
import { createInvite, joinLocalCommunity, serializeInvite } from "./inviteService.js";
import { notifyLocalMembersOfUpdate, notifyRemoteMembersOfUpdate } from "./notifyMembers.js";
import { transferOwnership } from "./transferOwnership.js";
import { deleteCommunity } from "./deleteCommunity.js";
import { COMMUNITY_VISIBILITIES, effectiveVisibility, isWiderThan, openJoinOf } from "../../lib/communityVisibility.js";
import { applyCommunitySnapshot, type CommunitySnapshot } from "../federation/communitySnapshot.js";
import { param } from "../../lib/params.js";

/** How a person is named in the audit log: by id, and as they were called at the time. */
const userTarget = (user: { protocolId: string; username: string; homeserverDomain: string }) => ({
  type: "user",
  id: user.protocolId,
  label: identityFor(user.username, user.homeserverDomain),
});

export const communitiesRouter = Router();

async function serializeCommunity(communityId: string, forUserId: string) {
  const community = await prisma.community.findUnique({
    where: { id: communityId },
    include: {
      owner: true,
      channels: {
        orderBy: { position: "asc" },
        include: {
          messages: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, senderId: true } },
          reads: { where: { userId: forUserId }, select: { lastReadAt: true } },
        },
      },
      roles: { orderBy: { position: "asc" } },
      members: { include: { user: true, roles: { include: { role: true } } } },
    },
  });
  if (!community) return null;
  return {
    id: community.protocolId,
    name: community.name,
    description: community.description,
    iconUrl: community.iconUrl,
    // The letters and colour of the tile when there is no picture; null for the default.
    iconText: community.iconText,
    iconColor: community.iconColor,
    // The server it lives on: with the id, the code to join it from anywhere ("<id>:<domain>").
    homeserverDomain: community.homeserverDomain,
    // Who may join (lib/communityVisibility.ts) as it is IN FORCE (the setting, held to the server's limit), the widest the server
    // lets one be, and the old yes/no derived from it for anything that still reads that.
    visibility: effectiveVisibility(community.visibility, config.communityVisibilityLimit),
    visibilityLimit: config.communityVisibilityLimit,
    openJoin: openJoinOf(effectiveVisibility(community.visibility, config.communityVisibilityLimit)),
    owner: publicUser(community.owner),
    createdAt: community.createdAt,
    channels: community.channels.map((c) => {
      const lastMessage = c.messages[0];
      const lastReadAt = c.reads[0]?.lastReadAt ?? null;
      const unread = !!lastMessage && lastMessage.senderId !== forUserId && (!lastReadAt || lastMessage.createdAt > lastReadAt);
      return {
        id: c.protocolId,
        name: c.name,
        topic: c.topic,
        type: c.type,
        position: c.position,
        unread,
      };
    }),
    roles: community.roles.map(serializeRole),
    members: community.members.map((m) => ({
      ...publicUser(m.user),
      nickname: m.nickname,
      joinedAt: m.joinedAt,
      roles: m.roles.map((mr) => mr.role.name),
      roleIds: m.roles.map((mr) => mr.roleId),
    })),
  };
}

function serializeRole(r: { id: string; name: string; color: string | null; position: number; permissions: bigint; isDefault: boolean }) {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
    permissions: r.permissions.toString(),
    isDefault: r.isDefault,
  };
}

/**
 * A non-owner may only create, edit, delete, assign or unassign a role whose
 * permissions they hold themselves (the owner holds everything, so is never
 * limited). Without this ceiling anyone with MANAGE_ROLES could mint a role
 * with every permission and hand it to themselves; it also stops a moderator
 * editing, deleting or stripping a role more powerful than they are.
 */
function withinActorPermissions(actorPerms: bigint, rolePerms: bigint): boolean {
  return (rolePerms & ~actorPerms) === 0n;
}

async function getMembership(communityId: string, userId: string) {
  return prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId } },
    include: { roles: { include: { role: true } } },
  });
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

communitiesRouter.post("/", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const community = await prisma.$transaction(async (tx) => {
    const community = await tx.community.create({
      data: {
        protocolId: newProtocolId(),
        name: parsed.data.name,
        description: parsed.data.description,
        ownerId: req.userId!,
        homeserverDomain: config.domain,
        isRemote: false,
        // Where this server starts new communities (COMMUNITY_VISIBILITY_DEFAULT; unlisted, as ever, unless the operator chose).
        visibility: config.communityVisibilityDefault,
      },
    });
    const everyoneRole = await tx.role.create({
      data: {
        communityId: community.id,
        name: "@everyone",
        permissions: DEFAULT_MEMBER_PERMISSIONS,
        isDefault: true,
        position: 0,
      },
    });
    const member = await tx.communityMember.create({
      data: { communityId: community.id, userId: req.userId! },
    });
    await tx.memberRole.create({ data: { memberId: member.id, roleId: everyoneRole.id } });
    await tx.channel.create({
      data: { protocolId: newProtocolId(), communityId: community.id, name: "general", position: 0 },
    });
    return community;
  });

  res.status(201).json({ community: await serializeCommunity(community.id, req.userId!) });
});

communitiesRouter.get("/", requireAuth, async (req, res) => {
  const memberships = await prisma.communityMember.findMany({
    where: { userId: req.userId! },
    include: { community: true },
  });
  res.json({
    communities: await Promise.all(memberships.map((m) => serializeCommunity(m.communityId, req.userId!))),
  });
});

async function resolveCommunity(protocolId: string) {
  return prisma.community.findUnique({ where: { protocolId } });
}

communitiesRouter.get("/:id", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  const membership = await getMembership(community.id, req.userId!);
  if (!membership) return res.status(403).json({ error: "not_a_member" });
  res.json({ community: await serializeCommunity(community.id, req.userId!) });
});

// Who is in each of the community's voice channels right now (people's protocolIds), straight from the voice server. A client
// asks once when it opens the community and is then told of every change (the `voice:participants` event). `available` is false
// where there is nothing to ask: this server has no voice, the community is on another server, or the voice server did not answer.
communitiesRouter.get("/:id/voice", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  const membership = await getMembership(community.id, req.userId!);
  if (!membership) return res.status(403).json({ error: "not_a_member" });
  if (community.isRemote || !getVoiceBackend()) return res.json({ available: false, channels: {} });

  const state = await voiceStateOf(await voiceChannelIdsOf(community.id));
  const channels: Record<string, string[]> = {};
  for (const [channelId, participants] of Object.entries(state)) {
    // A room that could not be read is left out: the client keeps what it had rather than showing an empty channel.
    if (participants !== null) channels[channelId] = participants;
  }
  const unreadable = Object.values(state).some((participants) => participants === null);
  res.json({ available: !unreadable, channels });
});

// Handing a community to someone else is the owner's alone (never a permission bit, so no delegated
// manager can do it) and the old owner can't take it back, so it asks for their password again - the
// same confirmation the 2FA settings use - and is rate limited like a login, since the password check
// is otherwise an oracle for a stolen access token.
const transferOwnerSchema = z.object({ userId: z.string().min(1), password: z.string().min(1) });

communitiesRouter.put("/:id/owner", authLimiter, requireAuth, async (req, res) => {
  const parsed = transferOwnerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });
  if (community.ownerId !== req.userId) return res.status(403).json({ error: "forbidden" });

  const self = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!self?.passwordHash || !(await verifyPassword(parsed.data.password, self.passwordHash))) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const target = await prisma.user.findUnique({ where: { protocolId: parsed.data.userId } });
  if (!target) return res.status(404).json({ error: "user_not_found" });
  // A remote user as owner would own a community nobody can manage: management by a remote member
  // isn't supported, so the community would be stuck.
  // The rules (a local member, someone else) and what follows (everyone told) are the shared function's, which the admin page uses too.
  const moved = await transferOwnership(community, target, req.userId!);
  if (!moved.ok) return res.status(moved.error === "not_a_member" ? 404 : moved.error === "ownership_changed" ? 409 : 400).json({ error: moved.error });
  await recordUserAudit(req.userId!, { action: "community.transfer", community, target: userTarget(target) });
  res.json({ community: await serializeCommunity(community.id, req.userId!) });
});

// Deleting takes everything with it: the schema cascades the channels, messages, reactions, roles,
// memberships, bans and the community's own emoticons. What the cascade can't reach is handled here:
// every member is told, remote members' servers are pinged to drop their cached copy (they re-fetch,
// get 404 and drop it - see the /updated handler in federation/routes.ts), and the uploaded files
// nothing else uses are removed.
communitiesRouter.delete("/:id", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });
  if (community.ownerId !== req.userId) return res.status(403).json({ error: "forbidden" });

  await deleteCommunity(community);
  await recordUserAudit(req.userId!, { action: "community.delete", community, target: { type: "community", id: community.protocolId, label: community.name } });

  res.status(204).end();
});

// The tile on the rail: a picture, or 1-3 letters on a colour (null for any of them = the default).
// Checked here and again when a snapshot arrives from another server (lib/communityIcon.ts).
const iconTextField = z
  .string()
  .transform((value, ctx) => {
    const text = sanitizeIconText(value);
    if (text === null) ctx.addIssue({ code: "custom", message: "1 to 3 characters, no control characters" });
    return text ?? "";
  })
  .nullable();
const iconColorField = z
  .string()
  .transform((value, ctx) => {
    const colour = sanitizeIconColor(value);
    if (colour === null) ctx.addIssue({ code: "custom", message: "#rrggbb" });
    return colour ?? "";
  })
  .nullable();

const updateCommunitySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  iconUrl: z.string().refine(isIconUrl, "an uploaded file or an http(s) image URL").nullable().optional(),
  iconText: iconTextField.optional(),
  iconColor: iconColorField.optional(),
  visibility: z.enum(COMMUNITY_VISIBILITIES).optional(),
  // The old yes/no, still accepted from a client that predates `visibility`: false closes the community to invite-only, true
  // reopens an invite-only one (any other setting is left as it is).
  openJoin: z.boolean().optional(),
});

communitiesRouter.patch("/:id", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  // A remote member exercising management permissions isn't supported yet
  // (see protocol/federation.md's "Communities" section) - without this
  // guard, a local cached CommunityMember whose mirrored role happens to
  // carry MANAGE_COMMUNITY (because the resync is designed to cache
  // faithfully) would silently mutate the *local stub only*, with no real
  // authorization and no proxy to the actual owner, then get silently
  // stomped back by the next resync with no explanation.
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.MANAGE_COMMUNITY)) return res.status(403).json({ error: "forbidden" });

  const parsed = updateCommunitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const { openJoin, ...changes } = parsed.data;
  // A server can limit how exposed to other servers its communities may be: a wider choice is refused, saying why.
  if (changes.visibility && isWiderThan(changes.visibility, config.communityVisibilityLimit)) {
    return res.status(409).json({ error: "visibility_limited", limit: config.communityVisibilityLimit });
  }
  const wanted =
    changes.visibility ??
    (openJoin === undefined ? undefined : openJoin ? (community.visibility === "INVITE_ONLY" ? "UNLISTED" : community.visibility) : "INVITE_ONLY");
  const visibility = wanted && effectiveVisibility(wanted, config.communityVisibilityLimit);
  await prisma.community.update({ where: { id: community.id }, data: { ...changes, ...(visibility ? { visibility } : {}) } });
  await recordUserAudit(req.userId!, {
    action: "community.update",
    community,
    target: { type: "community", id: community.protocolId, label: community.name },
    // Which fields, never their values (a description can say anything): except the name and who can join, which are what an operator looks for.
    details: {
      fields: [...Object.entries(changes).filter(([, v]) => v !== undefined).map(([k]) => k), ...(openJoin !== undefined ? ["openJoin"] : [])],
      ...(changes.name !== undefined ? { newName: changes.name } : {}),
      ...(visibility ? { visibility } : {}),
    },
  });
  // A replaced or removed picture is deleted unless something else uses the file (judged after the
  // update, so "still used" means by someone other than this community).
  if (parsed.data.iconUrl !== undefined && community.iconUrl && community.iconUrl !== parsed.data.iconUrl) {
    await deleteUnreferencedMedia([community.iconUrl]);
  }
  // Other members' clients refetch, so a new name or tile shows without a reload (remote members' servers
  // are pinged to refetch the snapshot).
  await notifyLocalMembersOfUpdate(community.id);
  await notifyRemoteMembersOfUpdate(community);
  res.json({ community: await serializeCommunity(community.id, req.userId!) });
});

/**
 * Joins a community. `:id` is either a bare protocolId (a community we
 * already have a local - possibly cached-remote - row for) or a federated
 * reference "<protocolId>:<domain>" for a community we're joining for the
 * first time and have no local row for yet; either may be followed by
 * "#<invite code>". The code can instead come in the body (`inviteCode`),
 * which wins. Whether a person may join - banned, open to anyone or only with
 * an invite, an invite's expiry, uses and revocation - is decided by the
 * community's HOME server (joinLocalCommunity), so a federated join is a
 * synchronous proxy that carries the code and passes the home server's answer
 * back unchanged.
 */
const joinBodySchema = z.object({ inviteCode: z.string().regex(INVITE_CODE_PATTERN).optional() });

communitiesRouter.post("/:id/members", requireAuth, async (req, res) => {
  const ref = parseJoinReference(param(req, "id"), config.domain);
  if (!ref) return res.status(400).json({ error: "invalid_request" });
  const body = joinBodySchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: "invalid_request" });
  const inviteCode = body.data.inviteCode ?? ref.code ?? undefined;

  if (ref.domain !== config.domain) {
    const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    let response: { community: CommunitySnapshot };
    try {
      response = await proxyToHomeServer<{ community: CommunitySnapshot }>(
        ref.domain,
        `/communities/${ref.protocolId}/members`,
        {
          body: {
            protocolId: self.protocolId,
            username: self.username,
            displayName: self.displayName,
            avatarUrl: self.avatarUrl,
            inviteCode,
          },
        }
      );
    } catch (err) {
      if (err instanceof FederationProxyError) return res.status(err.status).json(err.body);
      return res.status(502).json({ error: "federation_unreachable" });
    }

    const community = await applyCommunitySnapshot(response.community, ref.domain);
    await prisma.communityMember.upsert({
      where: { communityId_userId: { communityId: community.id, userId: req.userId! } },
      create: { communityId: community.id, userId: req.userId! },
      update: {},
    });
    return res.status(201).json({ community: await serializeCommunity(community.id, req.userId!) });
  }

  const community = await resolveCommunity(ref.protocolId);
  if (!community) return res.status(404).json({ error: "not_found" });

  const joined = await joinLocalCommunity(community, { id: req.userId!, isRemote: false }, inviteCode);
  if (!joined.ok) return res.status(joined.status).json({ error: joined.error });

  res.status(201).json({ community: await serializeCommunity(community.id, req.userId!) });
});

// --- Invites -------------------------------------------------------------
// A code that can expire, be limited and be revoked (lib/invites.ts). They live on the community's home server.
// Creating one needs CREATE_INVITE; a member sees and revokes their own, and MANAGE_COMMUNITY sees and revokes all.

communitiesRouter.post("/:id/invites", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  const parsed = createInviteSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  if (community.isRemote) {
    // The home server mints it: ours only holds a cached copy. It checks that this person is a member who may.
    const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    if (!(await getMembership(community.id, req.userId!))) return res.status(403).json({ error: "not_a_member" });
    let response: { invite: { code: string; expiresAt: string | null; maxUses: number | null; createdAt: string } };
    try {
      response = await proxyToHomeServer(community.homeserverDomain, `/communities/${community.protocolId}/invites`, {
        body: { username: self.username, ...parsed.data },
      });
    } catch (err) {
      if (err instanceof FederationProxyError) return res.status(err.status).json(err.body);
      return res.status(502).json({ error: "federation_unreachable" });
    }
    // Only the home server lists and revokes, so what is shown is what it just said.
    return res.status(201).json({
      invite: {
        id: null,
        code: response.invite.code,
        reference: inviteJoinReference(community, response.invite.code),
        expiresAt: response.invite.expiresAt,
        maxUses: response.invite.maxUses,
        uses: 0,
        revokedAt: null,
        viaCard: false,
        status: "active",
        createdAt: response.invite.createdAt,
        createdBy: publicUser(self, req.userId!),
      },
    });
  }

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.CREATE_INVITE)) return res.status(403).json({ error: "forbidden" });

  const invite = await createInvite({ communityId: community.id, createdById: req.userId!, ...parsed.data });
  const full = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id }, include: { createdBy: true } });
  res.status(201).json({ invite: serializeInvite(full, community) });
});

communitiesRouter.get("/:id/invites", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  // Invites are only kept by the home server, which is where they are listed.
  if (community.isRemote) return res.status(409).json({ error: "not_community_home" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!(await getMembership(community.id, req.userId!))) return res.status(403).json({ error: "forbidden" });
  const seesAll = hasPermission(perms, Permission.MANAGE_COMMUNITY);
  // Invites that went out as cards in conversations are one per card and would bury the rest; ?cards=1 includes them.
  const includeCards = req.query.cards === "1";

  const invites = await prisma.invite.findMany({
    where: {
      communityId: community.id,
      ...(seesAll ? {} : { createdById: req.userId! }),
      ...(includeCards ? {} : { viaCard: false }),
    },
    include: { createdBy: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({ invites: invites.map((i) => serializeInvite(i, community)), seesAll });
});

communitiesRouter.delete("/:id/invites/:inviteId", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "not_community_home" });

  const invite = await prisma.invite.findUnique({ where: { id: param(req, "inviteId") } });
  // An id from another community is the same as no such invite.
  if (!invite || invite.communityId !== community.id) return res.status(404).json({ error: "invite_not_found" });

  const isMember = !!(await getMembership(community.id, req.userId!));
  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  const mayRevoke = isMember && (hasPermission(perms, Permission.MANAGE_COMMUNITY) || invite.createdById === req.userId);
  if (!mayRevoke) return res.status(403).json({ error: "forbidden" });

  // Revoking twice is fine; the first time stays on record.
  if (!invite.revokedAt) await prisma.invite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
  res.status(204).end();
});

communitiesRouter.delete("/:id/members/me", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.ownerId === req.userId) return res.status(400).json({ error: "owner_cannot_leave" });

  if (community.isRemote) {
    const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    try {
      await proxyToHomeServer(community.homeserverDomain, `/communities/${community.protocolId}/members/leave`, {
        body: { username: self.username },
      });
    } catch (err) {
      if (err instanceof FederationProxyError) return res.status(err.status).json(err.body);
      return res.status(502).json({ error: "federation_unreachable" });
    }
    await prisma.communityMember.deleteMany({ where: { communityId: community.id, userId: req.userId! } });
    return res.status(204).end();
  }

  await prisma.communityMember.deleteMany({ where: { communityId: community.id, userId: req.userId! } });
  await disconnectFromVoice(community.id, (await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } })).protocolId);
  await notifyLocalMembersOfUpdate(community.id);
  res.status(204).end();
});

communitiesRouter.delete("/:id/members/:userId", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.KICK_MEMBERS)) return res.status(403).json({ error: "forbidden" });

  const target = await prisma.user.findUnique({ where: { protocolId: param(req, "userId") } });
  if (!target) return res.status(404).json({ error: "user_not_found" });
  if (target.id === community.ownerId) return res.status(400).json({ error: "cannot_kick_owner" });

  await prisma.communityMember.deleteMany({ where: { communityId: community.id, userId: target.id } });
  await recordUserAudit(req.userId!, { action: "member.kick", community, target: userTarget(target) });
  await emitSyncEvent([target.id], "community:kicked", { communityId: community.protocolId });
  await disconnectFromVoice(community.id, target.protocolId);
  await notifyLocalMembersOfUpdate(community.id);
  if (target.isRemote) await notifyRemoteMembersOfUpdate(community, target.homeserverDomain);
  res.status(204).end();
});

const banSchema = z.object({ protocolId: z.string().min(1), reason: z.string().max(256).optional() });

communitiesRouter.post("/:id/bans", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.BAN_MEMBERS)) return res.status(403).json({ error: "forbidden" });

  const parsed = banSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  // By protocolId, not username (like kick/unban below) - a username-only
  // lookup here used to go through findLocalUserByUsername(), which only
  // ever matches a *local*, non-remote user. That silently failed to find
  // (404) any cached remote member - an ordinary case now that communities
  // federate, not an edge case - even though they're a real member shown
  // in the member list.
  const target = await prisma.user.findUnique({ where: { protocolId: parsed.data.protocolId } });
  if (!target) return res.status(404).json({ error: "user_not_found" });
  if (target.id === community.ownerId) return res.status(400).json({ error: "cannot_ban_owner" });

  await prisma.$transaction([
    prisma.communityBan.upsert({
      where: { communityId_userId: { communityId: community.id, userId: target.id } },
      create: { communityId: community.id, userId: target.id, reason: parsed.data.reason },
      update: { reason: parsed.data.reason },
    }),
    prisma.communityMember.deleteMany({ where: { communityId: community.id, userId: target.id } }),
  ]);
  await recordUserAudit(req.userId!, { action: "member.ban", community, target: userTarget(target), details: { hasReason: Boolean(parsed.data.reason) } });
  await emitSyncEvent([target.id], "community:banned", { communityId: community.protocolId, reason: parsed.data.reason });
  await disconnectFromVoice(community.id, target.protocolId);
  await notifyLocalMembersOfUpdate(community.id);
  if (target.isRemote) await notifyRemoteMembersOfUpdate(community, target.homeserverDomain);
  res.status(204).end();
});

communitiesRouter.get("/:id/bans", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.BAN_MEMBERS)) return res.status(403).json({ error: "forbidden" });

  const bans = await prisma.communityBan.findMany({
    where: { communityId: community.id },
    orderBy: { createdAt: "desc" },
  });
  // CommunityBan has no `user` relation in the schema, so the banned
  // users are fetched separately and joined here rather than via Prisma
  // `include`.
  const users = await prisma.user.findMany({ where: { id: { in: bans.map((b) => b.userId) } } });
  const usersById = new Map(users.map((u) => [u.id, u]));
  res.json({
    bans: bans.flatMap((b) => {
      const user = usersById.get(b.userId);
      return user ? [{ user: publicUser(user), reason: b.reason, createdAt: b.createdAt }] : [];
    }),
  });
});

// What the community's managers did, newest first (#59): the same entries the admin page shows for it, for the people who run it. Only
// someone who can manage the community sees it, and only its own entries (the community comes from the URL and is checked, never taken
// from a filter). It is about the community and never about what anyone said in it.
const auditQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  action: z.string().refine(isAuditAction, "an action the log knows").optional(),
});

communitiesRouter.get("/:id/audit-log", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.MANAGE_COMMUNITY)) return res.status(403).json({ error: "forbidden" });

  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  res.json(await listAudit({ ...parsed.data, communityId: community.protocolId }));
});

communitiesRouter.delete("/:id/bans/:userId", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.BAN_MEMBERS)) return res.status(403).json({ error: "forbidden" });

  const target = await prisma.user.findUnique({ where: { protocolId: param(req, "userId") } });
  if (!target) return res.status(404).json({ error: "user_not_found" });

  await prisma.communityBan.deleteMany({ where: { communityId: community.id, userId: target.id } });
  await recordUserAudit(req.userId!, { action: "member.unban", community, target: userTarget(target) });
  res.status(204).end();
});

// A permissions bitmask arrives as a decimal string (it's a BigInt, which JSON
// can't carry). Anything non-numeric, or with bits no permission defines, is a
// 400 - BigInt() on a bad string would otherwise throw into a 500.
const permissionsField = z
  .string()
  .regex(/^\d{1,19}$/)
  .transform((v) => BigInt(v))
  .refine((v) => (v & ~ALL_PERMISSIONS) === 0n, "unknown permission bits");
const colorField = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const createRoleSchema = z.object({
  name: z.string().min(1).max(50),
  color: colorField.optional(),
  permissions: permissionsField.optional(),
});

const updateRoleSchema = z
  .object({
    name: z.string().min(1).max(50).optional(),
    color: colorField.nullable().optional(),
    permissions: permissionsField.optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), { message: "nothing to update" });

// Shared by the role and channel management endpoints: the community must
// exist, be ours to manage, and the caller must hold `required`. Sends the
// error response itself and returns null in those cases.
async function loadCommunityForManagement(req: Request, res: Response, required: bigint) {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (community.isRemote) {
    res.status(409).json({ error: "remote_community_management_not_supported" });
    return null;
  }
  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, required)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return { community, perms };
}

// A role id from the URL is a raw DB id - it must be looked up *within* this
// community, never trusted on its own, or a role belonging to another
// community could be attached to a member here.
function findRoleInCommunity(communityId: string, roleId: string) {
  return prisma.role.findFirst({ where: { id: roleId, communityId } });
}

communitiesRouter.post("/:id/roles", requireAuth, async (req, res) => {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_ROLES);
  if (!loaded) return;

  const parsed = createRoleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const permissions = parsed.data.permissions ?? 0n;
  if (!withinActorPermissions(loaded.perms, permissions)) {
    return res.status(403).json({ error: "role_exceeds_your_permissions" });
  }

  const role = await prisma.role.create({
    data: { communityId: loaded.community.id, name: parsed.data.name, color: parsed.data.color, permissions },
  });
  await recordUserAudit(req.userId!, { action: "role.create", community: loaded.community, target: { type: "role", id: role.id, label: role.name }, details: { permissions: role.permissions.toString() } });
  await notifyLocalMembersOfUpdate(loaded.community.id);
  res.status(201).json({ role: serializeRole(role) });
});

communitiesRouter.patch("/:id/roles/:roleId", requireAuth, async (req, res) => {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_ROLES);
  if (!loaded) return;

  const role = await findRoleInCommunity(loaded.community.id, param(req, "roleId"));
  if (!role) return res.status(404).json({ error: "role_not_found" });

  const parsed = updateRoleSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  if (role.isDefault && parsed.data.name !== undefined && parsed.data.name !== role.name) {
    return res.status(400).json({ error: "cannot_rename_default_role" });
  }
  // Both the role as it is and as it would become must be within the caller's
  // own permissions: you can't edit a role above you, or raise one past you.
  if (
    !withinActorPermissions(loaded.perms, role.permissions) ||
    (parsed.data.permissions !== undefined && !withinActorPermissions(loaded.perms, parsed.data.permissions))
  ) {
    return res.status(403).json({ error: "role_exceeds_your_permissions" });
  }

  const updated = await prisma.role.update({ where: { id: role.id }, data: parsed.data });
  await recordUserAudit(req.userId!, {
    action: "role.update",
    community: loaded.community,
    target: { type: "role", id: role.id, label: role.name },
    details: {
      fields: Object.entries(parsed.data).filter(([, v]) => v !== undefined).map(([k]) => k),
      ...(parsed.data.permissions !== undefined ? { permissionsBefore: role.permissions.toString(), permissionsAfter: updated.permissions.toString() } : {}),
    },
  });
  // Taking CONNECT_VOICE away from a role must also end the calls of the people who only had it through it, not only stop them joining next time.
  if (parsed.data.permissions !== undefined) await disconnectWhoCannotConnect(loaded.community);
  await notifyLocalMembersOfUpdate(loaded.community.id);
  res.json({ role: serializeRole(updated) });
});

communitiesRouter.delete("/:id/roles/:roleId", requireAuth, async (req, res) => {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_ROLES);
  if (!loaded) return;

  const role = await findRoleInCommunity(loaded.community.id, param(req, "roleId"));
  if (!role) return res.status(404).json({ error: "role_not_found" });
  if (role.isDefault) return res.status(409).json({ error: "cannot_delete_default_role" });
  if (!withinActorPermissions(loaded.perms, role.permissions)) {
    return res.status(403).json({ error: "role_exceeds_your_permissions" });
  }

  await prisma.role.delete({ where: { id: role.id } }); // MemberRole rows cascade
  await recordUserAudit(req.userId!, { action: "role.delete", community: loaded.community, target: { type: "role", id: role.id, label: role.name } });
  await disconnectWhoCannotConnect(loaded.community); // what the role gave them went with it
  await notifyLocalMembersOfUpdate(loaded.community.id);
  res.status(204).end();
});

// Assign and unassign share everything but the final write.
async function changeMemberRole(req: Request, res: Response, change: "assign" | "unassign") {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_ROLES);
  if (!loaded) return;

  const role = await findRoleInCommunity(loaded.community.id, param(req, "roleId"));
  if (!role) return res.status(404).json({ error: "role_not_found" });
  if (!withinActorPermissions(loaded.perms, role.permissions)) {
    return res.status(403).json({ error: "role_exceeds_your_permissions" });
  }

  const target = await prisma.user.findUnique({ where: { protocolId: param(req, "userId") } });
  if (!target) return res.status(404).json({ error: "user_not_found" });
  const member = await getMembership(loaded.community.id, target.id);
  if (!member) return res.status(404).json({ error: "not_a_member" });

  if (change === "assign") {
    await prisma.memberRole.upsert({
      where: { memberId_roleId: { memberId: member.id, roleId: role.id } },
      create: { memberId: member.id, roleId: role.id },
      update: {},
    });
  } else {
    await prisma.memberRole.deleteMany({ where: { memberId: member.id, roleId: role.id } });
  }
  await recordUserAudit(req.userId!, {
    action: change === "assign" ? "member.role.add" : "member.role.remove",
    community: loaded.community,
    target: userTarget(target),
    details: { role: role.name },
  });
  // Only taking a role away can take a permission away.
  if (change === "unassign") await disconnectWhoCannotConnect(loaded.community);
  await notifyLocalMembersOfUpdate(loaded.community.id);
  res.status(204).end();
}

communitiesRouter.post("/:id/members/:userId/roles/:roleId", requireAuth, (req, res) =>
  changeMemberRole(req, res, "assign")
);
communitiesRouter.delete("/:id/members/:userId/roles/:roleId", requireAuth, (req, res) =>
  changeMemberRole(req, res, "unassign")
);

const createChannelSchema = z.object({ name: z.string().min(1).max(50), topic: z.string().max(256).optional(), type: z.enum(["TEXT", "VOICE"]).optional() });

communitiesRouter.post("/:id/channels", requireAuth, async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.MANAGE_CHANNELS)) return res.status(403).json({ error: "forbidden" });

  const parsed = createChannelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  // A voice channel nobody could join (this server has no LiveKit) is refused rather than made.
  if (parsed.data.type === "VOICE" && !config.voice.enabled) return res.status(409).json({ error: "voice_not_enabled" });

  const count = await prisma.channel.count({ where: { communityId: community.id } });
  const channel = await prisma.channel.create({
    data: {
      protocolId: newProtocolId(),
      communityId: community.id,
      name: parsed.data.name,
      topic: parsed.data.topic,
      type: parsed.data.type ?? "TEXT",
      position: count,
    },
  });

  const members = await prisma.communityMember.findMany({ where: { communityId: community.id } });
  await emitSyncEvent(
    members.map((m) => m.userId).filter((id) => id !== req.userId),
    "channel:created",
    { communityId: community.protocolId, channel: { id: channel.protocolId, name: channel.name, type: channel.type } }
  );
  await recordUserAudit(req.userId!, { action: "channel.create", community, target: { type: "channel", id: channel.protocolId, label: channel.name }, details: { type: channel.type } });
  await notifyRemoteMembersOfUpdate(community);
  res.status(201).json({ channel: serializeChannelSummary(channel) });
});

function serializeChannelSummary(c: { protocolId: string; name: string; topic: string | null; position: number; type: string }) {
  return { id: c.protocolId, name: c.name, topic: c.topic, type: c.type, position: c.position };
}

// A channel id from the URL only means something *within* this community.
function findChannelInCommunity(communityId: string, channelProtocolId: string) {
  return prisma.channel.findFirst({ where: { protocolId: channelProtocolId, communityId } });
}

// Local members' clients refetch; remote members' servers resync their cache
// (applyCommunitySnapshot upserts channels and drops any that are gone).
async function channelsChanged(community: Awaited<ReturnType<typeof resolveCommunity>> & {}) {
  await notifyLocalMembersOfUpdate(community.id);
  await notifyRemoteMembersOfUpdate(community);
}

// Serialises delete/reorder within one community, so two concurrent requests
// can't each pass the "not the last channel" check and leave none.
function lockCommunity(tx: Prisma.TransactionClient, communityId: string) {
  return tx.$queryRaw`SELECT id FROM "Community" WHERE id = ${communityId} FOR UPDATE`;
}

const updateChannelSchema = z
  .object({
    name: z.string().min(1).max(50).optional(),
    // blank clears the topic
    topic: z
      .string()
      .max(256)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), { message: "nothing to update" });

communitiesRouter.patch("/:id/channels/:channelId", requireAuth, async (req, res) => {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_CHANNELS);
  if (!loaded) return;

  const channel = await findChannelInCommunity(loaded.community.id, param(req, "channelId"));
  if (!channel) return res.status(404).json({ error: "channel_not_found" });

  const parsed = updateChannelSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const updated = await prisma.channel.update({ where: { id: channel.id }, data: parsed.data });
  await recordUserAudit(req.userId!, {
    action: "channel.update",
    community: loaded.community,
    target: { type: "channel", id: channel.protocolId, label: channel.name },
    details: { fields: Object.entries(parsed.data).filter(([, v]) => v !== undefined).map(([k]) => k), ...(parsed.data.name !== undefined ? { newName: parsed.data.name } : {}) },
  });
  await channelsChanged(loaded.community);
  res.json({ channel: serializeChannelSummary(updated) });
});

// Permanently deletes the channel and, via the schema's cascade, every message
// and read cursor in it. A community always keeps at least one channel.
communitiesRouter.delete("/:id/channels/:channelId", requireAuth, async (req, res) => {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_CHANNELS);
  if (!loaded) return;

  const channel = await findChannelInCommunity(loaded.community.id, param(req, "channelId"));
  if (!channel) return res.status(404).json({ error: "channel_not_found" });

  const deleted = await prisma.$transaction(async (tx) => {
    await lockCommunity(tx, loaded.community.id);
    const all = await tx.channel.findMany({ where: { communityId: loaded.community.id }, orderBy: { position: "asc" } });
    if (all.length <= 1) return false;

    await tx.channel.delete({ where: { id: channel.id } });
    // Keep positions contiguous (0..n-1): channel creation assigns position by
    // count, so a gap would let a new channel collide with an existing one.
    const remaining = all.filter((c) => c.id !== channel.id);
    for (const [index, c] of remaining.entries()) {
      if (c.position !== index) await tx.channel.update({ where: { id: c.id }, data: { position: index } });
    }
    return true;
  });
  if (!deleted) return res.status(409).json({ error: "last_channel" });
  // A voice channel has a room on the voice server: close it, sending anyone in it out.
  if (channel.type === "VOICE") await closeVoiceRooms([channel.protocolId]);
  await recordUserAudit(req.userId!, { action: "channel.delete", community: loaded.community, target: { type: "channel", id: channel.protocolId, label: channel.name }, details: { type: channel.type } });

  await channelsChanged(loaded.community);
  res.status(204).end();
});

// Body is the community's channel ids in their new order - it must be exactly
// the community's current channels, each once, nothing missing or foreign.
const reorderChannelsSchema = z.object({ order: z.array(z.string().min(1)).min(1).max(500) });

communitiesRouter.put("/:id/channels/order", requireAuth, async (req, res) => {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_CHANNELS);
  if (!loaded) return;

  const parsed = reorderChannelsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { order } = parsed.data;

  const reordered = await prisma.$transaction(async (tx) => {
    await lockCommunity(tx, loaded.community.id);
    const channels = await tx.channel.findMany({ where: { communityId: loaded.community.id } });
    const known = new Set(channels.map((c) => c.protocolId));
    if (order.length !== known.size || new Set(order).size !== order.length || !order.every((id) => known.has(id))) {
      return null;
    }
    const byProtocolId = new Map(channels.map((c) => [c.protocolId, c]));
    for (const [index, protocolId] of order.entries()) {
      const c = byProtocolId.get(protocolId)!;
      if (c.position !== index) await tx.channel.update({ where: { id: c.id }, data: { position: index } });
    }
    return order.map((protocolId, index) => serializeChannelSummary({ ...byProtocolId.get(protocolId)!, position: index }));
  });
  if (!reordered) return res.status(400).json({ error: "invalid_order" });

  await channelsChanged(loaded.community);
  res.json({ channels: reordered });
});

export { getMemberPermissions, resolveCommunity };
