import { Router } from "express";
import { z } from "zod";
import type { FriendRequest, User } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { newProtocolId } from "../../lib/ids.js";
import { publicUser } from "../../lib/serialize.js";
import { emitSyncEvent } from "../sync/events.js";

export const friendsRouter = Router();

type FriendRequestWithUsers = FriendRequest & { fromUser: User; toUser: User };

function serializeRequest(fr: FriendRequestWithUsers) {
  return {
    id: fr.protocolId,
    from: publicUser(fr.fromUser),
    to: publicUser(fr.toUser),
    message: fr.message,
    status: fr.status,
    createdAt: fr.createdAt,
  };
}

const sendRequestSchema = z.object({
  username: z.string().min(1),
  message: z.string().max(256).optional(),
});

friendsRouter.post("/requests", requireAuth, async (req, res) => {
  const parsed = sendRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const target = await prisma.user.findUnique({ where: { username: parsed.data.username } });
  if (!target) return res.status(404).json({ error: "user_not_found" });
  if (target.id === req.userId) return res.status(400).json({ error: "cannot_friend_self" });

  const [blocked, blockedBy, alreadyFriends] = await Promise.all([
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: req.userId!, blockedId: target.id } } }),
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: target.id, blockedId: req.userId! } } }),
    prisma.friendship.findUnique({ where: { userId_friendId: { userId: req.userId!, friendId: target.id } } }),
  ]);
  if (blocked || blockedBy) return res.status(403).json({ error: "blocked" });
  if (alreadyFriends) return res.status(409).json({ error: "already_friends" });

  const existingPending = await prisma.friendRequest.findFirst({
    where: {
      status: "PENDING",
      OR: [
        { fromUserId: req.userId!, toUserId: target.id },
        { fromUserId: target.id, toUserId: req.userId! },
      ],
    },
  });
  if (existingPending) return res.status(409).json({ error: "request_already_pending" });

  const request = await prisma.friendRequest.create({
    data: {
      protocolId: newProtocolId(),
      fromUserId: req.userId!,
      toUserId: target.id,
      message: parsed.data.message,
    },
    include: { fromUser: true, toUser: true },
  });

  await emitSyncEvent([target.id], "friend_request:created", { request: serializeRequest(request) });
  res.status(201).json({ request: serializeRequest(request) });
});

friendsRouter.get("/requests", requireAuth, async (req, res) => {
  const direction = req.query.direction as string | undefined;
  const where =
    direction === "outgoing"
      ? { fromUserId: req.userId! }
      : direction === "incoming"
        ? { toUserId: req.userId! }
        : { OR: [{ fromUserId: req.userId! }, { toUserId: req.userId! }] };

  const requests = await prisma.friendRequest.findMany({
    where: { ...where, status: "PENDING" },
    include: { fromUser: true, toUser: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ requests: requests.map(serializeRequest) });
});

async function resolveRequest(id: string, userId: string) {
  const request = await prisma.friendRequest.findUnique({
    where: { protocolId: id },
    include: { fromUser: true, toUser: true },
  });
  if (!request) return null;
  if (request.fromUserId !== userId && request.toUserId !== userId) return null;
  return request;
}

friendsRouter.post("/requests/:id/accept", requireAuth, async (req, res) => {
  const request = await resolveRequest(req.params.id, req.userId!);
  if (!request || request.toUserId !== req.userId) return res.status(404).json({ error: "not_found" });
  if (request.status !== "PENDING") return res.status(409).json({ error: "already_resolved" });

  await prisma.$transaction([
    prisma.friendRequest.update({ where: { id: request.id }, data: { status: "ACCEPTED", resolvedAt: new Date() } }),
    prisma.friendship.create({ data: { userId: request.fromUserId, friendId: request.toUserId } }),
    prisma.friendship.create({ data: { userId: request.toUserId, friendId: request.fromUserId } }),
  ]);

  await emitSyncEvent([request.fromUserId], "friend_request:accepted", {
    friend: publicUser(request.toUser),
  });
  res.json({ friend: publicUser(request.fromUser) });
});

friendsRouter.post("/requests/:id/decline", requireAuth, async (req, res) => {
  const request = await resolveRequest(req.params.id, req.userId!);
  if (!request || request.toUserId !== req.userId) return res.status(404).json({ error: "not_found" });
  if (request.status !== "PENDING") return res.status(409).json({ error: "already_resolved" });

  await prisma.friendRequest.update({ where: { id: request.id }, data: { status: "DECLINED", resolvedAt: new Date() } });
  await emitSyncEvent([request.fromUserId], "friend_request:declined", { requestId: request.protocolId });
  res.status(204).end();
});

friendsRouter.post("/requests/:id/cancel", requireAuth, async (req, res) => {
  const request = await resolveRequest(req.params.id, req.userId!);
  if (!request || request.fromUserId !== req.userId) return res.status(404).json({ error: "not_found" });
  if (request.status !== "PENDING") return res.status(409).json({ error: "already_resolved" });

  await prisma.friendRequest.update({ where: { id: request.id }, data: { status: "CANCELLED", resolvedAt: new Date() } });
  await emitSyncEvent([request.toUserId], "friend_request:cancelled", { requestId: request.protocolId });
  res.status(204).end();
});

friendsRouter.get("/", requireAuth, async (req, res) => {
  const friendships = await prisma.friendship.findMany({
    where: { userId: req.userId! },
    include: { friend: true },
    orderBy: { createdAt: "asc" },
  });
  res.json({ friends: friendships.map((f) => publicUser(f.friend)) });
});

friendsRouter.delete("/:userId", requireAuth, async (req, res) => {
  const target = await prisma.user.findUnique({ where: { protocolId: req.params.userId } });
  if (!target) return res.status(404).json({ error: "not_found" });

  await prisma.$transaction([
    prisma.friendship.deleteMany({ where: { userId: req.userId!, friendId: target.id } }),
    prisma.friendship.deleteMany({ where: { userId: target.id, friendId: req.userId! } }),
  ]);
  await emitSyncEvent([target.id], "friend:removed", { userId: req.userId });
  res.status(204).end();
});

// --- Blocks -----------------------------------------------------------

const blockSchema = z.object({ username: z.string().min(1) });

friendsRouter.post("/blocks", requireAuth, async (req, res) => {
  const parsed = blockSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const target = await prisma.user.findUnique({ where: { username: parsed.data.username } });
  if (!target) return res.status(404).json({ error: "user_not_found" });
  if (target.id === req.userId) return res.status(400).json({ error: "cannot_block_self" });

  await prisma.$transaction([
    prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId: req.userId!, blockedId: target.id } },
      create: { blockerId: req.userId!, blockedId: target.id },
      update: {},
    }),
    prisma.friendship.deleteMany({ where: { userId: req.userId!, friendId: target.id } }),
    prisma.friendship.deleteMany({ where: { userId: target.id, friendId: req.userId! } }),
  ]);
  res.status(204).end();
});

friendsRouter.delete("/blocks/:userId", requireAuth, async (req, res) => {
  const target = await prisma.user.findUnique({ where: { protocolId: req.params.userId } });
  if (!target) return res.status(404).json({ error: "not_found" });

  await prisma.block.deleteMany({ where: { blockerId: req.userId!, blockedId: target.id } });
  res.status(204).end();
});

friendsRouter.get("/blocks", requireAuth, async (req, res) => {
  const blocks = await prisma.block.findMany({ where: { blockerId: req.userId! }, include: { blocked: true } });
  res.json({ blocked: blocks.map((b) => publicUser(b.blocked)) });
});
