import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { newProtocolId } from "../../lib/ids.js";
import { publicUser } from "../../lib/serialize.js";
import {
  ALL_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  Permission,
  combinePermissions,
  hasPermission,
} from "../../lib/permissions.js";
import { emitSyncEvent } from "../sync/events.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { FederationProxyError, proxyToHomeServer } from "../../lib/federation/proxy.js";
import { getRemoteCommunityDomains } from "../messages/federationRelay.js";
import { applyCommunitySnapshot, type CommunitySnapshot } from "../federation/communitySnapshot.js";

export const communitiesRouter = Router();

/**
 * Parses a community reference - a bare protocolId (local) or
 * "<protocolId>:<domain>" (federated), same separator convention as
 * parseIdentity() (server/src/lib/ids.ts) - but deliberately NOT a thin
 * wrapper around it: parseIdentity() lowercases its first capture group,
 * which is correct for a username (already lowercase-normalized at
 * registration) but WRONG here - a protocolId is a case-sensitive ULID
 * (the `ulid` package generates uppercase), and lowercasing it would break
 * every existing bare-protocolId lookup silently (Postgres text comparison
 * is case-sensitive by default).
 */
function parseCommunityReference(input: string, defaultDomain: string): { protocolId: string; domain: string } | null {
  const trimmed = input.trim();
  const match = /^@?([0-9A-Za-z]+)(?::(.+))?$/.exec(trimmed);
  if (!match) return null;
  const [, protocolId, domain] = match;
  return { protocolId, domain: (domain ?? defaultDomain).toLowerCase() };
}

/**
 * Pings a remote domain (or every remote domain with a member here, if
 * `targetDomain` is omitted) to re-sync their cached copy of this
 * (locally-owned) community - deliberately one unified "something changed,
 * re-fetch" signal rather than a granular event per change-type (channel
 * created vs renamed, role changed, member kicked/banned, ...), to avoid a
 * combinatorial explosion of relay event types. Self-healing under
 * reordering: a resync always re-fetches current state regardless of which
 * ping triggered it, so two in-flight pings (or one arriving "late") can
 * never leave a receiver worse off than the single most recent one would
 * have. `targetDomain` is used for a kick/ban affecting one specific
 * remote member - the snapshot itself carries no member-list data, so the
 * only thing pinging *other* members would accomplish is a wasted round
 * trip; what matters is that the affected domain's own resync hits the
 * snapshot endpoint's membership gate and discovers it's no longer
 * welcome. No-ops for a remote community (we're never the one who'd notify
 * anyone about our own cache of someone else's community).
 */
async function notifyRemoteMembersOfUpdate(
  community: { id: string; protocolId: string; isRemote: boolean },
  targetDomain?: string
) {
  if (community.isRemote) return;
  const domains = targetDomain ? [targetDomain] : await getRemoteCommunityDomains(community.id);
  for (const domain of domains) {
    await enqueueFederationEvent(domain, `/communities/${community.protocolId}/updated`, {});
  }
}

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

// Tells every local member's client to refetch the community - a role or
// channel change is otherwise only visible to the person who made it until
// they reload. (Remote members' caches are handled separately, via
// notifyRemoteMembersOfUpdate.)
async function notifyLocalMembersOfUpdate(communityId: string) {
  const members = await prisma.communityMember.findMany({
    where: { communityId, user: { isRemote: false } },
    select: { userId: true },
  });
  await emitSyncEvent(
    members.map((m) => m.userId),
    "community:updated",
    {}
  );
}

async function getMembership(communityId: string, userId: string) {
  return prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId } },
    include: { roles: { include: { role: true } } },
  });
}

async function getMemberPermissions(communityId: string, userId: string, ownerId: string): Promise<bigint> {
  if (userId === ownerId) return ALL_PERMISSIONS;
  const membership = await getMembership(communityId, userId);
  if (!membership) return 0n;
  return combinePermissions(membership.roles.map((r) => r.role.permissions));
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
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });
  const membership = await getMembership(community.id, req.userId!);
  if (!membership) return res.status(403).json({ error: "not_a_member" });
  res.json({ community: await serializeCommunity(community.id, req.userId!) });
});

const updateCommunitySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  iconUrl: z.string().min(1).nullable().optional(),
});

communitiesRouter.patch("/:id", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
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

  await prisma.community.update({ where: { id: community.id }, data: parsed.data });
  await notifyRemoteMembersOfUpdate(community);
  res.json({ community: await serializeCommunity(community.id, req.userId!) });
});

/**
 * Joins a community. `:id` is either a bare protocolId (a community we
 * already have a local - possibly cached-remote - row for) or a federated
 * reference "<protocolId>:<domain>" for a community we're joining for the
 * first time and have no local row for yet. Local join stays open in this
 * MVP (no invite codes / private communities yet); a federated join is a
 * synchronous proxy to the real home server, which enforces its own ban
 * check.
 */
communitiesRouter.post("/:id/members", requireAuth, async (req, res) => {
  const ref = parseCommunityReference(req.params.id, config.domain);
  if (!ref) return res.status(400).json({ error: "invalid_request" });

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

  const banned = await prisma.communityBan.findUnique({
    where: { communityId_userId: { communityId: community.id, userId: req.userId! } },
  });
  if (banned) return res.status(403).json({ error: "banned" });

  const everyoneRole = await prisma.role.findFirst({ where: { communityId: community.id, isDefault: true } });
  const member = await prisma.communityMember.upsert({
    where: { communityId_userId: { communityId: community.id, userId: req.userId! } },
    create: { communityId: community.id, userId: req.userId! },
    update: {},
  });
  if (everyoneRole) {
    await prisma.memberRole.upsert({
      where: { memberId_roleId: { memberId: member.id, roleId: everyoneRole.id } },
      create: { memberId: member.id, roleId: everyoneRole.id },
      update: {},
    });
  }

  res.status(201).json({ community: await serializeCommunity(community.id, req.userId!) });
});

communitiesRouter.delete("/:id/members/me", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
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
  res.status(204).end();
});

communitiesRouter.delete("/:id/members/:userId", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.KICK_MEMBERS)) return res.status(403).json({ error: "forbidden" });

  const target = await prisma.user.findUnique({ where: { protocolId: req.params.userId } });
  if (!target) return res.status(404).json({ error: "user_not_found" });
  if (target.id === community.ownerId) return res.status(400).json({ error: "cannot_kick_owner" });

  await prisma.communityMember.deleteMany({ where: { communityId: community.id, userId: target.id } });
  await emitSyncEvent([target.id], "community:kicked", { communityId: community.protocolId });
  if (target.isRemote) await notifyRemoteMembersOfUpdate(community, target.homeserverDomain);
  res.status(204).end();
});

const banSchema = z.object({ protocolId: z.string().min(1), reason: z.string().max(256).optional() });

communitiesRouter.post("/:id/bans", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
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
  await emitSyncEvent([target.id], "community:banned", { communityId: community.protocolId, reason: parsed.data.reason });
  if (target.isRemote) await notifyRemoteMembersOfUpdate(community, target.homeserverDomain);
  res.status(204).end();
});

communitiesRouter.get("/:id/bans", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
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

communitiesRouter.delete("/:id/bans/:userId", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.BAN_MEMBERS)) return res.status(403).json({ error: "forbidden" });

  const target = await prisma.user.findUnique({ where: { protocolId: req.params.userId } });
  if (!target) return res.status(404).json({ error: "user_not_found" });

  await prisma.communityBan.deleteMany({ where: { communityId: community.id, userId: target.id } });
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
  const community = await resolveCommunity(req.params.id);
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
  await notifyLocalMembersOfUpdate(loaded.community.id);
  res.status(201).json({ role: serializeRole(role) });
});

communitiesRouter.patch("/:id/roles/:roleId", requireAuth, async (req, res) => {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_ROLES);
  if (!loaded) return;

  const role = await findRoleInCommunity(loaded.community.id, req.params.roleId);
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
  await notifyLocalMembersOfUpdate(loaded.community.id);
  res.json({ role: serializeRole(updated) });
});

communitiesRouter.delete("/:id/roles/:roleId", requireAuth, async (req, res) => {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_ROLES);
  if (!loaded) return;

  const role = await findRoleInCommunity(loaded.community.id, req.params.roleId);
  if (!role) return res.status(404).json({ error: "role_not_found" });
  if (role.isDefault) return res.status(409).json({ error: "cannot_delete_default_role" });
  if (!withinActorPermissions(loaded.perms, role.permissions)) {
    return res.status(403).json({ error: "role_exceeds_your_permissions" });
  }

  await prisma.role.delete({ where: { id: role.id } }); // MemberRole rows cascade
  await notifyLocalMembersOfUpdate(loaded.community.id);
  res.status(204).end();
});

// Assign and unassign share everything but the final write.
async function changeMemberRole(req: Request, res: Response, change: "assign" | "unassign") {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_ROLES);
  if (!loaded) return;

  const role = await findRoleInCommunity(loaded.community.id, req.params.roleId);
  if (!role) return res.status(404).json({ error: "role_not_found" });
  if (!withinActorPermissions(loaded.perms, role.permissions)) {
    return res.status(403).json({ error: "role_exceeds_your_permissions" });
  }

  const target = await prisma.user.findUnique({ where: { protocolId: req.params.userId } });
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
  await notifyLocalMembersOfUpdate(loaded.community.id);
  res.status(204).end();
}

communitiesRouter.post("/:id/members/:userId/roles/:roleId", requireAuth, (req, res) =>
  changeMemberRole(req, res, "assign")
);
communitiesRouter.delete("/:id/members/:userId/roles/:roleId", requireAuth, (req, res) =>
  changeMemberRole(req, res, "unassign")
);

const createChannelSchema = z.object({ name: z.string().min(1).max(50), topic: z.string().max(256).optional() });

communitiesRouter.post("/:id/channels", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.MANAGE_CHANNELS)) return res.status(403).json({ error: "forbidden" });

  const parsed = createChannelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const count = await prisma.channel.count({ where: { communityId: community.id } });
  const channel = await prisma.channel.create({
    data: {
      protocolId: newProtocolId(),
      communityId: community.id,
      name: parsed.data.name,
      topic: parsed.data.topic,
      position: count,
    },
  });

  const members = await prisma.communityMember.findMany({ where: { communityId: community.id } });
  await emitSyncEvent(
    members.map((m) => m.userId).filter((id) => id !== req.userId),
    "channel:created",
    { communityId: community.protocolId, channel: { id: channel.protocolId, name: channel.name } }
  );
  await notifyRemoteMembersOfUpdate(community);
  res.status(201).json({ channel: { id: channel.protocolId, name: channel.name, topic: channel.topic, position: channel.position } });
});

function serializeChannelSummary(c: { protocolId: string; name: string; topic: string | null; position: number }) {
  return { id: c.protocolId, name: c.name, topic: c.topic, position: c.position };
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

  const channel = await findChannelInCommunity(loaded.community.id, req.params.channelId);
  if (!channel) return res.status(404).json({ error: "channel_not_found" });

  const parsed = updateChannelSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const updated = await prisma.channel.update({ where: { id: channel.id }, data: parsed.data });
  await channelsChanged(loaded.community);
  res.json({ channel: serializeChannelSummary(updated) });
});

// Permanently deletes the channel and, via the schema's cascade, every message
// and read cursor in it. A community always keeps at least one channel.
communitiesRouter.delete("/:id/channels/:channelId", requireAuth, async (req, res) => {
  const loaded = await loadCommunityForManagement(req, res, Permission.MANAGE_CHANNELS);
  if (!loaded) return;

  const channel = await findChannelInCommunity(loaded.community.id, req.params.channelId);
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
