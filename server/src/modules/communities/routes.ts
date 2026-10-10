import { Router } from "express";
import { z } from "zod";
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
import { findLocalUserByUsername } from "../../lib/users.js";
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
    roles: community.roles.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      position: r.position,
      permissions: r.permissions.toString(),
      isDefault: r.isDefault,
    })),
    members: community.members.map((m) => ({
      ...publicUser(m.user),
      nickname: m.nickname,
      joinedAt: m.joinedAt,
      roles: m.roles.map((mr) => mr.role.name),
    })),
  };
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

const banSchema = z.object({ username: z.string().min(1), reason: z.string().max(256).optional() });

communitiesRouter.post("/:id/bans", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.BAN_MEMBERS)) return res.status(403).json({ error: "forbidden" });

  const parsed = banSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const target = await findLocalUserByUsername(parsed.data.username);
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

const roleSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().max(16).optional(),
  permissions: z.string().optional(),
});

communitiesRouter.post("/:id/roles", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.MANAGE_ROLES)) return res.status(403).json({ error: "forbidden" });

  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const role = await prisma.role.create({
    data: {
      communityId: community.id,
      name: parsed.data.name,
      color: parsed.data.color,
      permissions: parsed.data.permissions ? BigInt(parsed.data.permissions) : 0n,
    },
  });
  res.status(201).json({ role: { ...role, permissions: role.permissions.toString() } });
});

communitiesRouter.post("/:id/members/:userId/roles/:roleId", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.MANAGE_ROLES)) return res.status(403).json({ error: "forbidden" });

  const target = await prisma.user.findUnique({ where: { protocolId: req.params.userId } });
  if (!target) return res.status(404).json({ error: "user_not_found" });
  const member = await getMembership(community.id, target.id);
  if (!member) return res.status(404).json({ error: "not_a_member" });

  await prisma.memberRole.upsert({
    where: { memberId_roleId: { memberId: member.id, roleId: req.params.roleId } },
    create: { memberId: member.id, roleId: req.params.roleId },
    update: {},
  });
  res.status(204).end();
});

communitiesRouter.delete("/:id/members/:userId/roles/:roleId", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "remote_community_management_not_supported" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.MANAGE_ROLES)) return res.status(403).json({ error: "forbidden" });

  const target = await prisma.user.findUnique({ where: { protocolId: req.params.userId } });
  if (!target) return res.status(404).json({ error: "user_not_found" });
  const member = await getMembership(community.id, target.id);
  if (!member) return res.status(404).json({ error: "not_a_member" });

  await prisma.memberRole.deleteMany({ where: { memberId: member.id, roleId: req.params.roleId } });
  res.status(204).end();
});

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

export { getMemberPermissions, resolveCommunity };
