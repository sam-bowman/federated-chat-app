import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { newProtocolId, identityFor } from "../../lib/ids.js";
import { param } from "../../lib/params.js";
import { publicUser } from "../../lib/serialize.js";
import { generateBotToken, hashBotToken } from "../../lib/botToken.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import { recordUserAudit } from "../audit/service.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { getMemberPermissions } from "../communities/memberPermissions.js";
import { addMemberWithEveryoneRole } from "../communities/inviteService.js";
import { notifyLocalMembersOfUpdate, notifyRemoteMembersOfUpdate } from "../communities/notifyMembers.js";
import { purgeAccount } from "../users/deletion.js";
import { closeConnectionsOf } from "../../ws/gateway.js";
import type { User } from "../../generated/prisma/client.js";

// Bot accounts (#132, phase 1). A bot is a `User` with `isBot`: no password, never signs in, acts with a long-lived token (lib/botToken.ts)
// that is shown once. The person who made it manages it here; a community's managers add it to their community like any member, and what it
// may do there is decided by the roles it holds. Everything in this file is for PEOPLE (`requireAuth`): a bot token is refused here, so a
// bot can never make bots, add itself anywhere or regenerate its own token. The routes a bot itself uses (messages, reactions, history) say
// `requireAuthOrBot` where they are defined.

const userTarget = (user: Pick<User, "protocolId" | "username" | "homeserverDomain">) => ({
  type: "user",
  id: user.protocolId,
  label: identityFor(user.username, user.homeserverDomain),
});

const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9_]+$/, "username must be lowercase letters, digits, or underscores");

const createSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(64).optional(),
  // Lenient on purpose, like the profile's: the disk driver's /uploads/x.png is relative.
  avatarUrl: z.string().min(1).nullable().optional(),
});

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  avatarUrl: z.string().min(1).nullable().optional(),
});

/** A bot as its owner sees it: the public view of the account plus when it was made. The token is never part of it. */
function serializeBot(bot: User, viewerId: string) {
  return { ...publicUser(bot, viewerId), createdAt: bot.createdAt };
}

function requireBotsEnabled(_req: Request, res: Response, next: NextFunction) {
  if (!config.botsEnabled) return res.status(403).json({ error: "bots_disabled" });
  next();
}

/** One of the signed-in person's own bots, by protocol id. Someone else's is a 404, the same as one that does not exist. */
async function ownBot(req: Request) {
  return prisma.user.findFirst({
    where: { protocolId: param(req, "id"), isBot: true, botOwnerId: req.userId!, deletedAt: null },
  });
}

export const botsRouter = Router();

botsRouter.get("/", requireAuth, requireBotsEnabled, async (req, res) => {
  const bots = await prisma.user.findMany({
    where: { isBot: true, botOwnerId: req.userId!, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  res.json({ bots: bots.map((b) => serializeBot(b, req.userId!)), limit: config.botsPerUserLimit });
});

botsRouter.post("/", requireAuth, requireBotsEnabled, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { username, displayName, avatarUrl } = parsed.data;

  const owned = await prisma.user.count({ where: { isBot: true, botOwnerId: req.userId!, deletedAt: null } });
  if (owned >= config.botsPerUserLimit) return res.status(409).json({ error: "too_many_bots", limit: config.botsPerUserLimit });

  // A bot's name is taken from the same pool as everyone's, including names that belonged to accounts that were deleted (#60).
  if ((await findLocalUserByUsername(username)) || (await prisma.deletedUsername.findUnique({ where: { username } }))) {
    return res.status(409).json({ error: "username_taken" });
  }

  const token = generateBotToken();
  let bot: User;
  try {
    bot = await prisma.user.create({
      data: {
        protocolId: newProtocolId(),
        username,
        displayName: displayName ?? username,
        avatarUrl: avatarUrl ?? null,
        homeserverDomain: config.domain,
        isRemote: false,
        isBot: true,
        botOwnerId: req.userId!,
        botTokenHash: hashBotToken(token),
        // Nobody on another server can look it up or befriend it (see isVisibleToDomain); it is reached through communities.
        discoverable: false,
        contactPolicy: "LOCAL_ONLY",
      },
    });
  } catch (err) {
    // Two people choosing the same name at once: the unique key decides.
    if ((err as { code?: string }).code === "P2002") return res.status(409).json({ error: "username_taken" });
    throw err;
  }
  await recordUserAudit(req.userId!, { action: "bot.create", target: userTarget(bot) });
  // The only time the token is ever shown.
  res.status(201).json({ bot: serializeBot(bot, req.userId!), token });
});

botsRouter.patch("/:id", requireAuth, requireBotsEnabled, async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const bot = await ownBot(req);
  if (!bot) return res.status(404).json({ error: "not_found" });
  const updated = await prisma.user.update({
    where: { id: bot.id },
    data: { displayName: parsed.data.displayName, avatarUrl: parsed.data.avatarUrl },
  });
  res.json({ bot: serializeBot(updated, req.userId!) });
});

// A new token, which ends the old one at once for requests and within a heartbeat for a connection that is open (this replica's, at once).
botsRouter.post("/:id/token", requireAuth, requireBotsEnabled, async (req, res) => {
  const bot = await ownBot(req);
  if (!bot) return res.status(404).json({ error: "not_found" });
  const token = generateBotToken();
  await prisma.user.update({ where: { id: bot.id }, data: { botTokenHash: hashBotToken(token) } });
  closeConnectionsOf(bot.id);
  await recordUserAudit(req.userId!, { action: "bot.token_regenerate", target: userTarget(bot) });
  res.json({ token });
});

// Deleting a bot erases it as an account is erased (modules/users/deletion.ts): its messages and memberships go, and the name stays taken.
// Allowed even when bots are switched off, so an owner can still clean up.
botsRouter.delete("/:id", requireAuth, async (req, res) => {
  const bot = await ownBot(req);
  if (!bot) return res.status(404).json({ error: "not_found" });
  // The token stops working first, so nothing the bot does while it is being erased is accepted.
  await prisma.user.update({ where: { id: bot.id }, data: { botTokenHash: null } });
  closeConnectionsOf(bot.id);
  const result = await purgeAccount(bot.id);
  if (!result.ok && result.error !== "already_deleted") return res.status(409).json({ error: result.error });
  await recordUserAudit(req.userId!, { action: "bot.delete", target: userTarget(bot) });
  res.status(204).end();
});

// --- Adding a bot to a community --------------------------------------------------------------------------------------------------------
// Mounted under /communities. Removing one is the ordinary kick (DELETE /communities/:id/members/:userId), and what it may do is the
// ordinary roles, so a bot is held to exactly what a member is.

export const communityBotsRouter = Router();

const addSchema = z.object({ username: usernameSchema });

communityBotsRouter.post("/:id/bots", requireAuth, requireBotsEnabled, async (req, res) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const community = await prisma.community.findUnique({ where: { protocolId: param(req, "id") } });
  if (!community) return res.status(404).json({ error: "not_found" });
  // Someone who is not in it cannot tell it exists.
  const membership = await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: req.userId! } } });
  if (!membership) return res.status(404).json({ error: "not_found" });
  // A bot lives on this server, so it can only be added to a community this server hosts.
  if (community.isRemote) return res.status(409).json({ error: "not_community_home" });
  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.MANAGE_COMMUNITY)) return res.status(403).json({ error: "forbidden" });

  const bot = await prisma.user.findFirst({
    where: { username: parsed.data.username, homeserverDomain: config.domain, isBot: true, isRemote: false, deletedAt: null },
  });
  if (!bot) return res.status(404).json({ error: "bot_not_found" });
  if (await prisma.communityBan.findUnique({ where: { communityId_userId: { communityId: community.id, userId: bot.id } } })) {
    return res.status(409).json({ error: "bot_banned" });
  }

  const alreadyIn = await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: bot.id } } });
  if (alreadyIn) return res.status(409).json({ error: "already_member" });

  const everyoneRole = await prisma.role.findFirst({ where: { communityId: community.id, isDefault: true } });
  await prisma.$transaction((tx) => addMemberWithEveryoneRole(tx, community.id, bot.id, everyoneRole?.id));
  await notifyLocalMembersOfUpdate(community.id);
  await notifyRemoteMembersOfUpdate(community);
  await recordUserAudit(req.userId!, { action: "community.bot_add", community, target: userTarget(bot) });
  res.status(201).json({ bot: publicUser(bot, req.userId!) });
});
