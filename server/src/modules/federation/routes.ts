import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireFederationAuth } from "../../middleware/federationAuth.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { publicUser, serializeFriendRequest } from "../../lib/serialize.js";
import { emitSyncEvent } from "../sync/events.js";
import { ensureRemoteUser } from "./remoteUsers.js";
import { getAccessibleEmoticons } from "../emoticons/service.js";
import { serializeMessage } from "../messages/serialize.js";
import { sendToUsers } from "../../ws/gateway.js";

export const federationRouter = Router();

// Every /federation/v1/* route requires a verified signature from a known
// (or freshly-discovered) peer domain.
federationRouter.use(requireFederationAuth);

// Lets a peer resolve one of OUR users' public profile when their user
// references @someone:ourdomain (e.g. before delivering a friend request).
federationRouter.get("/users/:username", async (req, res) => {
  const user = await findLocalUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ user: publicUser(user) });
});

const incomingFriendRequestSchema = z.object({
  requestId: z.string().min(1),
  fromProtocolId: z.string().min(1),
  fromUsername: z.string().min(1),
  fromDisplayName: z.string().min(1),
  fromAvatarUrl: z.string().nullable().optional(),
  toUsername: z.string().min(1),
  message: z.string().nullable().optional(),
});

federationRouter.post("/friend-requests", async (req, res) => {
  const parsed = incomingFriendRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const toUser = await findLocalUserByUsername(parsed.data.toUsername);
  if (!toUser) return res.status(404).json({ error: "user_not_found" });

  const fromUser = await ensureRemoteUser({
    protocolId: parsed.data.fromProtocolId,
    username: parsed.data.fromUsername,
    domain: req.federationOrigin!,
    displayName: parsed.data.fromDisplayName,
    avatarUrl: parsed.data.fromAvatarUrl,
  });

  // Same protocolId as the sender's row, so their accept/decline callback
  // (POST /friend-requests/:id/accept|decline) can find this exact request.
  const request = await prisma.friendRequest.upsert({
    where: { protocolId: parsed.data.requestId },
    create: {
      protocolId: parsed.data.requestId,
      fromUserId: fromUser.id,
      toUserId: toUser.id,
      message: parsed.data.message,
    },
    update: {},
    include: { fromUser: true, toUser: true },
  });

  await emitSyncEvent([toUser.id], "friend_request:created", { request: serializeFriendRequest(request) });
  res.status(201).json({ ok: true });
});

async function resolveOriginatingRequest(requestId: string, originDomain: string) {
  const request = await prisma.friendRequest.findUnique({
    where: { protocolId: requestId },
    include: { fromUser: true, toUser: true },
  });
  if (!request) return null;
  // Only the recipient's own homeserver may resolve a request WE originated.
  if (request.toUser.homeserverDomain !== originDomain) return null;
  return request;
}

federationRouter.post("/friend-requests/:id/accept", async (req, res) => {
  const request = await resolveOriginatingRequest(req.params.id, req.federationOrigin!);
  if (!request || request.fromUser.homeserverDomain !== config.domain) {
    return res.status(404).json({ error: "not_found" });
  }
  if (request.status !== "PENDING") return res.status(409).json({ error: "already_resolved" });

  await prisma.$transaction([
    prisma.friendRequest.update({ where: { id: request.id }, data: { status: "ACCEPTED", resolvedAt: new Date() } }),
    prisma.friendship.create({ data: { userId: request.fromUserId, friendId: request.toUserId } }),
    prisma.friendship.create({ data: { userId: request.toUserId, friendId: request.fromUserId } }),
  ]);

  await emitSyncEvent([request.fromUserId], "friend_request:accepted", { friend: publicUser(request.toUser) });
  res.status(204).end();
});

federationRouter.post("/friend-requests/:id/decline", async (req, res) => {
  const request = await resolveOriginatingRequest(req.params.id, req.federationOrigin!);
  if (!request || request.fromUser.homeserverDomain !== config.domain) {
    return res.status(404).json({ error: "not_found" });
  }
  if (request.status !== "PENDING") return res.status(409).json({ error: "already_resolved" });

  await prisma.friendRequest.update({ where: { id: request.id }, data: { status: "DECLINED", resolvedAt: new Date() } });
  await emitSyncEvent([request.fromUserId], "friend_request:declined", { requestId: request.protocolId });
  res.status(204).end();
});

// --- Conversations & messages -------------------------------------------

const memberProfileSchema = z.object({
  protocolId: z.string().min(1),
  username: z.string().min(1),
  domain: z.string().min(1),
  displayName: z.string().min(1).optional(),
  avatarUrl: z.string().nullable().optional(),
});

const incomingConversationSchema = z.object({
  conversationId: z.string().min(1),
  type: z.enum(["DM", "GROUP"]),
  members: z.array(memberProfileSchema).min(2),
});

federationRouter.post("/conversations", async (req, res) => {
  const parsed = incomingConversationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  // This phase only federates 1:1 DMs - refuse to seed a group conversation
  // or one naming a third domain we weren't told about by its own peer.
  const otherDomains = new Set(parsed.data.members.map((m) => m.domain).filter((d) => d !== config.domain));
  if (otherDomains.size !== 1 || !otherDomains.has(req.federationOrigin!)) {
    return res.status(400).json({ error: "unsupported_member_set" });
  }

  const resolvedUserIds: string[] = [];
  for (const member of parsed.data.members) {
    if (member.domain === config.domain) {
      const local = await findLocalUserByUsername(member.username);
      if (!local) return res.status(404).json({ error: "user_not_found" });
      resolvedUserIds.push(local.id);
    } else {
      const remote = await ensureRemoteUser({
        protocolId: member.protocolId,
        username: member.username,
        domain: member.domain,
        displayName: member.displayName ?? member.username,
        avatarUrl: member.avatarUrl,
      });
      resolvedUserIds.push(remote.id);
    }
  }

  const conversation = await prisma.conversation.upsert({
    where: { protocolId: parsed.data.conversationId },
    create: {
      protocolId: parsed.data.conversationId,
      type: parsed.data.type,
      members: { create: resolvedUserIds.map((userId) => ({ userId })) },
    },
    update: {},
    include: { members: { include: { user: true } } },
  });

  const localMemberIds = conversation.members.filter((m) => !m.user.isRemote).map((m) => m.userId);
  await emitSyncEvent(localMemberIds, "conversation:created", {
    conversation: {
      id: conversation.protocolId,
      type: conversation.type,
      title: conversation.title,
      createdAt: conversation.createdAt,
      members: conversation.members.map((m) => ({ ...publicUser(m.user), nickname: m.nickname })),
    },
  });
  res.status(201).json({ ok: true });
});

const incomingAttachmentSchema = z.object({
  url: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const incomingMessageSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  fromProtocolId: z.string().min(1),
  fromUsername: z.string().min(1),
  fromDomain: z.string().min(1),
  content: z.string().min(1).max(8000),
  createdAt: z.string().or(z.date()).optional(),
  attachments: z.array(incomingAttachmentSchema).max(10).optional(),
});

federationRouter.post("/messages", async (req, res) => {
  const parsed = incomingMessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  if (parsed.data.fromDomain !== req.federationOrigin) {
    return res.status(403).json({ error: "sender_domain_mismatch" });
  }

  const conversation = await prisma.conversation.findUnique({ where: { protocolId: parsed.data.conversationId } });
  if (!conversation) return res.status(404).json({ error: "conversation_not_found" });

  const sender = await ensureRemoteUser({
    protocolId: parsed.data.fromProtocolId,
    username: parsed.data.fromUsername,
    domain: parsed.data.fromDomain,
    displayName: parsed.data.fromUsername,
  });
  // Verify the sender is actually a member of this conversation, rather
  // than trusting the payload outright.
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: conversation.id, userId: sender.id } },
  });
  if (!membership) return res.status(403).json({ error: "not_a_member" });

  const message = await prisma.message.upsert({
    where: { protocolId: parsed.data.messageId },
    create: {
      protocolId: parsed.data.messageId,
      conversationId: conversation.id,
      senderId: sender.id,
      content: parsed.data.content,
      createdAt: parsed.data.createdAt ? new Date(parsed.data.createdAt) : undefined,
      attachments: parsed.data.attachments ? { create: parsed.data.attachments } : undefined,
    },
    update: {},
    include: { sender: true, attachments: true, reactions: { include: { user: true } }, replyTo: { include: { sender: true } } },
  });

  const members = await prisma.conversationMember.findMany({ where: { conversationId: conversation.id }, include: { user: true } });
  const localMemberIds = members.filter((m) => !m.user.isRemote).map((m) => m.userId);
  const senderEmoticons = await getAccessibleEmoticons(sender.id);
  const serialized = serializeMessage(message as any, senderEmoticons);
  await emitSyncEvent(localMemberIds, "message:created", { message: serialized, conversationId: conversation.protocolId });
  res.status(201).json({ ok: true });
});

// --- Presence -------------------------------------------------------------

const incomingPresenceSchema = z.object({
  username: z.string().min(1),
  domain: z.string().min(1),
  status: z.enum(["ONLINE", "AWAY", "BUSY", "DO_NOT_DISTURB", "OFFLINE"]),
  customStatus: z.string().nullable().optional(),
});

federationRouter.post("/presence", async (req, res) => {
  const parsed = incomingPresenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  if (parsed.data.domain !== req.federationOrigin) return res.status(403).json({ error: "sender_domain_mismatch" });

  // Only relevant if at least one of our local users has already friended
  // this person (which is the only way their stub would exist) - otherwise
  // there's nobody local to notify.
  const remoteUser = await prisma.user.findUnique({
    where: { username_homeserverDomain: { username: parsed.data.username, homeserverDomain: parsed.data.domain } },
  });
  if (!remoteUser) return res.status(204).end();

  const updated = await prisma.user.update({
    where: { id: remoteUser.id },
    data: { presenceStatus: parsed.data.status, customStatus: parsed.data.customStatus ?? null },
  });

  const friendships = await prisma.friendship.findMany({ where: { friendId: remoteUser.id }, select: { userId: true } });
  sendToUsers(
    friendships.map((f) => f.userId),
    { type: "presence", userId: updated.protocolId, status: updated.presenceStatus, customStatus: updated.customStatus }
  );
  res.status(204).end();
});
