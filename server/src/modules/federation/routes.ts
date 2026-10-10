import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireFederationAuth } from "../../middleware/federationAuth.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { publicUser, serializeFriendRequest } from "../../lib/serialize.js";
import { emitSyncEvent } from "../sync/events.js";
import { ensureRemoteUser } from "./remoteUsers.js";
import { verifyRemoteMember } from "./identity.js";
import { getAccessibleEmoticons } from "../emoticons/service.js";
import { serializeMessage, messageInclude } from "../messages/serialize.js";
import { localMessageRecipients } from "../messages/federationRelay.js";
import { sendToUsers } from "../../ws/gateway.js";
import { MAX_GROUP_MEMBERS } from "../../lib/conversations.js";

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
  members: z.array(memberProfileSchema).min(2).max(MAX_GROUP_MEMBERS),
});

federationRouter.post("/conversations", async (req, res) => {
  const parsed = incomingConversationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  if (parsed.data.type === "DM" && parsed.data.members.length !== 2) {
    return res.status(400).json({ error: "dm_requires_exactly_two_members" });
  }

  // Each member is trusted differently depending on who's vouching for
  // them: a member on our own domain must already exist locally; a member
  // on the calling peer's own domain is trusted directly, since a peer is
  // always authoritative for describing its own users (same as today's
  // single-remote-domain case); a member on any OTHER domain is never
  // trusted from this payload alone - the calling peer could otherwise
  // plant an arbitrary protocolId for a third party we haven't actually
  // heard from, which would stick permanently (ensureRemoteUser's upsert
  // never overwrites protocolId on conflict). That third-party member is
  // independently verified by asking their own claimed domain directly,
  // the same mechanism resolveOrFetchUser uses for local group creation.
  type MemberResolution = { ok: true; userId: string } | { ok: false; error: "user_not_found" | "member_verification_failed" };
  const resolutions: MemberResolution[] = await Promise.all(
    parsed.data.members.map(async (member): Promise<MemberResolution> => {
      if (member.domain === config.domain) {
        const local = await findLocalUserByUsername(member.username);
        return local ? { ok: true, userId: local.id } : { ok: false, error: "user_not_found" };
      }
      if (member.domain === req.federationOrigin) {
        const remote = await ensureRemoteUser({
          protocolId: member.protocolId,
          username: member.username,
          domain: member.domain,
          displayName: member.displayName ?? member.username,
          avatarUrl: member.avatarUrl,
        });
        return { ok: true, userId: remote.id };
      }
      const verified = await verifyRemoteMember(member.domain, member.username);
      return verified ? { ok: true, userId: verified.id } : { ok: false, error: "member_verification_failed" };
    })
  );
  const failure = resolutions.find((r): r is Extract<MemberResolution, { ok: false }> => !r.ok);
  if (failure) {
    return res.status(failure.error === "user_not_found" ? 404 : 502).json({ error: failure.error });
  }
  const resolvedUserIds = resolutions.map((r) => (r as Extract<MemberResolution, { ok: true }>).userId);

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
    include: messageInclude,
  });

  const members = await prisma.conversationMember.findMany({ where: { conversationId: conversation.id }, include: { user: true } });
  const localMemberIds = members.filter((m) => !m.user.isRemote).map((m) => m.userId);
  const senderEmoticons = await getAccessibleEmoticons(sender.id);
  const serialized = serializeMessage(message as any, senderEmoticons);
  await emitSyncEvent(localMemberIds, "message:created", { message: serialized, conversationId: conversation.protocolId });
  res.status(201).json({ ok: true });
});

const incomingMessageEditSchema = z.object({ content: z.string().min(1).max(8000) });

federationRouter.post("/messages/:id/edit", async (req, res) => {
  const parsed = incomingMessageEditSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id }, include: { sender: true } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
  // Only the message's OWN homeserver may edit it - the same ownership
  // check POST /friend-requests/:id/accept|decline makes for a friend
  // request, just against the message's cached sender instead.
  if (message.sender.homeserverDomain !== req.federationOrigin) {
    return res.status(403).json({ error: "not_message_owner" });
  }

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { content: parsed.data.content, editedAt: new Date() },
    include: messageInclude,
  });

  const senderEmoticons = await getAccessibleEmoticons(message.senderId);
  const serialized = serializeMessage(updated as any, senderEmoticons);
  const { recipients, location } = await localMessageRecipients(message);
  await emitSyncEvent(recipients, "message:edited", { message: serialized, ...location });
  res.status(204).end();
});

federationRouter.post("/messages/:id/delete", async (req, res) => {
  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id }, include: { sender: true } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
  if (message.sender.homeserverDomain !== req.federationOrigin) {
    return res.status(403).json({ error: "not_message_owner" });
  }

  await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
  const { recipients, location } = await localMessageRecipients(message);
  await emitSyncEvent(recipients, "message:deleted", { messageId: message.protocolId, ...location });
  res.status(204).end();
});

const incomingReactionSchema = z.object({
  fromDomain: z.string().min(1),
  fromProtocolId: z.string().min(1),
  fromUsername: z.string().min(1),
  emoji: z.string().min(1).max(32),
});

// Caller must already have checked data.fromDomain === req.federationOrigin.
function resolveReactor(data: z.infer<typeof incomingReactionSchema>) {
  return ensureRemoteUser({
    protocolId: data.fromProtocolId,
    username: data.fromUsername,
    domain: data.fromDomain,
    displayName: data.fromUsername,
  });
}

federationRouter.post("/messages/:id/reactions", async (req, res) => {
  const parsed = incomingReactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  if (parsed.data.fromDomain !== req.federationOrigin) {
    return res.status(403).json({ error: "sender_domain_mismatch" });
  }

  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || message.deletedAt || !message.conversationId) return res.status(404).json({ error: "not_found" });

  const reactor = await resolveReactor(parsed.data);

  // Verify the reactor is actually a member of this message's conversation,
  // rather than trusting the payload outright - same pattern POST
  // /messages already uses for a message's sender.
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: message.conversationId, userId: reactor.id } },
  });
  if (!membership) return res.status(403).json({ error: "not_a_member" });

  await prisma.reaction.upsert({
    where: { messageId_userId_emoji: { messageId: message.id, userId: reactor.id, emoji: parsed.data.emoji } },
    create: { messageId: message.id, userId: reactor.id, emoji: parsed.data.emoji },
    update: {},
  });

  const updated = await prisma.message.findUnique({ where: { id: message.id }, include: messageInclude });
  const senderEmoticons = await getAccessibleEmoticons(message.senderId);
  const serialized = serializeMessage(updated as any, senderEmoticons);
  const { recipients, location } = await localMessageRecipients(message);
  await emitSyncEvent(recipients, "message:reaction_added", {
    messageId: message.protocolId,
    reactions: serialized.reactions,
    ...location,
  });
  res.status(204).end();
});

federationRouter.post("/messages/:id/reactions/remove", async (req, res) => {
  const parsed = incomingReactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  if (parsed.data.fromDomain !== req.federationOrigin) {
    return res.status(403).json({ error: "sender_domain_mismatch" });
  }

  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || !message.conversationId) return res.status(404).json({ error: "not_found" });

  const reactor = await resolveReactor(parsed.data);

  await prisma.reaction.deleteMany({
    where: { messageId: message.id, userId: reactor.id, emoji: parsed.data.emoji },
  });

  const updated = await prisma.message.findUnique({ where: { id: message.id }, include: messageInclude });
  const senderEmoticons = await getAccessibleEmoticons(message.senderId);
  const serialized = serializeMessage(updated as any, senderEmoticons);
  const { recipients, location } = await localMessageRecipients(message);
  await emitSyncEvent(recipients, "message:reaction_removed", {
    messageId: message.protocolId,
    reactions: serialized.reactions,
    ...location,
  });
  res.status(204).end();
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
