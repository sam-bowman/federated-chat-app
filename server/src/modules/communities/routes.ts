import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
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

export const communitiesRouter = Router();

async function serializeCommunity(communityId: string) {
  const community = await prisma.community.findUnique({
    where: { id: communityId },
    include: {
      owner: true,
      channels: { orderBy: { position: "asc" } },
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
    channels: community.channels.map((c) => ({
      id: c.protocolId,
      name: c.name,
      topic: c.topic,
      type: c.type,
      position: c.position,
    })),
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

  res.status(201).json({ community: await serializeCommunity(community.id) });
});

communitiesRouter.get("/", requireAuth, async (req, res) => {
  const memberships = await prisma.communityMember.findMany({
    where: { userId: req.userId! },
    include: { community: true },
  });
  res.json({
    communities: await Promise.all(memberships.map((m) => serializeCommunity(m.communityId))),
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
  res.json({ community: await serializeCommunity(community.id) });
});

const updateCommunitySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  iconUrl: z.string().min(1).nullable().optional(),
});

communitiesRouter.patch("/:id", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.MANAGE_COMMUNITY)) return res.status(403).json({ error: "forbidden" });

  const parsed = updateCommunitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  await prisma.community.update({ where: { id: community.id }, data: parsed.data });
  res.json({ community: await serializeCommunity(community.id) });
});

// Joining is open in this MVP (no invite codes / private communities yet).
communitiesRouter.post("/:id/members", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
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

  res.status(201).json({ community: await serializeCommunity(community.id) });
});

communitiesRouter.delete("/:id/members/me", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.ownerId === req.userId) return res.status(400).json({ error: "owner_cannot_leave" });

  await prisma.communityMember.deleteMany({ where: { communityId: community.id, userId: req.userId! } });
  res.status(204).end();
});

communitiesRouter.delete("/:id/members/:userId", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.KICK_MEMBERS)) return res.status(403).json({ error: "forbidden" });

  const target = await prisma.user.findUnique({ where: { protocolId: req.params.userId } });
  if (!target) return res.status(404).json({ error: "user_not_found" });
  if (target.id === community.ownerId) return res.status(400).json({ error: "cannot_kick_owner" });

  await prisma.communityMember.deleteMany({ where: { communityId: community.id, userId: target.id } });
  await emitSyncEvent([target.id], "community:kicked", { communityId: community.protocolId });
  res.status(204).end();
});

const banSchema = z.object({ username: z.string().min(1), reason: z.string().max(256).optional() });

communitiesRouter.post("/:id/bans", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.BAN_MEMBERS)) return res.status(403).json({ error: "forbidden" });

  const parsed = banSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const target = await prisma.user.findUnique({ where: { username: parsed.data.username } });
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
  res.status(204).end();
});

communitiesRouter.delete("/:id/bans/:userId", requireAuth, async (req, res) => {
  const community = await resolveCommunity(req.params.id);
  if (!community) return res.status(404).json({ error: "not_found" });

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
  res.status(201).json({ channel: { id: channel.protocolId, name: channel.name, topic: channel.topic, position: channel.position } });
});

export { getMemberPermissions, resolveCommunity };
