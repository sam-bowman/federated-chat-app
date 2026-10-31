import { Prisma } from "../../generated/prisma/client.js";
import { recordAudit } from "../audit/service.js";
import { Router, type Response } from "express";
import { hasReaction, reactionFromWire, reactionWire, wireReactionShape, type EmoticonRef, type ReactionKind } from "../../lib/emoticonReaction.js";
import { addReaction, removeReaction } from "../messages/reactions.js";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { isVisibleToDomain } from "../users/discoverability.js";
import { canContact, canContactIdentity } from "../users/contact.js";
import { parseDirectoryQuery } from "../../lib/directory.js";
import { listListedPeople, listPublicCommunities } from "../directory/service.js";
import { requireFederationAuth } from "../../middleware/federationAuth.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { publicUser, serializeFriendRequest } from "../../lib/serialize.js";
import { emitSyncEvent } from "../sync/events.js";
import { ensureRemoteUser } from "./remoteUsers.js";
import { verifyRemoteMember } from "./identity.js";
import { getAccessibleEmoticons } from "../emoticons/service.js";
import { serializeMessage, messageInclude } from "../messages/serialize.js";
import { localMessageRecipients, getRemoteCommunityDomains } from "../messages/federationRelay.js";
import { messageIsInCommunity } from "../messages/communityAuth.js";
import { sendToUsers } from "../../ws/gateway.js";
import { MAX_GROUP_MEMBERS } from "../../lib/conversations.js";
import { parseInvite } from "../../lib/invite.js";
import { resolveCommunity, getMemberPermissions } from "../communities/routes.js";
import { applyCommunitySnapshot, buildCommunitySnapshot, type CommunitySnapshot } from "./communitySnapshot.js";
import { FederationProxyError, proxyToHomeServer } from "../../lib/federation/proxy.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";
import { newProtocolId } from "../../lib/ids.js";
import { INVITE_CODE_PATTERN, createInviteSchema } from "../../lib/invites.js";
import { createInvite, joinLocalCommunity } from "../communities/inviteService.js";
import { parseEmbeds } from "../../lib/linkPreview/embed.js";
import { forgetRemoteUser } from "../users/deletion.js";
import { notifyLocalMembersOfUpdate } from "../communities/notifyMembers.js";
import { acceptsOtherServers, effectiveVisibility, type CommunityVisibility } from "../../lib/communityVisibility.js";
import { REPORT_REASONS } from "../../lib/reports.js";
import { createReport } from "../reports/service.js";
import { param } from "../../lib/params.js";

export const federationRouter = Router();

// Every /federation/v1/* route requires a verified signature from a known
// (or freshly-discovered) peer domain.
federationRouter.use(requireFederationAuth);

// Lets a peer resolve one of OUR users' public profile when their user
// references @someone:ourdomain (e.g. before delivering a friend request).
federationRouter.get("/users/:username", async (req, res) => {
  const user = await findLocalUserByUsername(param(req, "username"));
  // A person who is hidden from this server gets exactly the answer a person who does not exist gets (same status, same body,
  // same work), so nothing says they are here. See modules/users/discoverability.ts.
  // (The check runs even when there is no such person, which is what keeps the two alike.)
  const visible = await isVisibleToDomain(user, req.federationOrigin!);
  if (!user || !visible) return res.status(404).json({ error: "not_found" });
  // Asked on behalf of someone (`?from=name`, a person on the asking server), also says whether this person's setting lets them
  // start something: a courtesy so the asking server can refuse early and plainly. It is decided again when it is actually sent.
  const from = typeof req.query.from === "string" && req.query.from !== "" ? req.query.from : null;
  const contact = from ? { allowed: await canContactIdentity(user, req.federationOrigin!, from) } : undefined;
  // `memberSince` and `contact` are additive: a peer that does not know them ignores them, and one that sends none gets none.
  res.json({ user: publicUser(user), memberSince: user.createdAt, contact });
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
  // Nobody can be contacted by a server that is not allowed to find them: it gets the answer for a person who does not exist.
  const visible = await isVisibleToDomain(toUser, req.federationOrigin!);
  if (!toUser || !visible) return res.status(404).json({ error: "user_not_found" });

  const fromUser = await ensureRemoteUser({
    protocolId: parsed.data.fromProtocolId,
    username: parsed.data.fromUsername,
    domain: req.federationOrigin!,
    displayName: parsed.data.fromDisplayName,
    avatarUrl: parsed.data.fromAvatarUrl,
  });

  // The person's own setting decides who may start something (lib/contactPolicy.ts). A request that is not allowed is not shown to
  // them, and the sender is told it was declined, which is what it looks like from their side whether a person said no or a setting
  // did. (A request that was already delivered is left alone: this one is a repeat.)
  const alreadyDelivered = await prisma.friendRequest.findUnique({ where: { protocolId: parsed.data.requestId }, select: { id: true } });
  if (!alreadyDelivered && !(await canContact(toUser, fromUser))) {
    await enqueueFederationEvent(req.federationOrigin!, `/friend-requests/${parsed.data.requestId}/decline`, {});
    return res.status(201).json({ ok: true });
  }

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
  const request = await resolveOriginatingRequest(param(req, "id"), req.federationOrigin!);
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
  const request = await resolveOriginatingRequest(param(req, "id"), req.federationOrigin!);
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
  // Who is creating it (a username on the sending server). Optional: a server that predates it does not say, and then every other
  // member has to be someone each person added would have accepted.
  createdBy: z.string().min(1).optional(),
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
        const visible = await isVisibleToDomain(local, req.federationOrigin!);
        return local && visible ? { ok: true, userId: local.id } : { ok: false, error: "user_not_found" };
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

  // Each person added judges their own setting (lib/contactPolicy.ts) against whoever is adding them - the creator, if the sender
  // says who, otherwise every other member. A conversation that already exists is not being started, so it is left alone. One
  // person who does not accept it means it is not made at all: it is one conversation, not one per person.
  const alreadyExists = await prisma.conversation.findUnique({ where: { protocolId: parsed.data.conversationId }, select: { id: true } });
  if (!alreadyExists) {
    const rows = await prisma.user.findMany({ where: { id: { in: resolvedUserIds } } });
    const origin = req.federationOrigin!.toLowerCase();
    const creator = parsed.data.createdBy
      ? rows.find((u) => u.isRemote && u.username === parsed.data.createdBy && u.homeserverDomain.toLowerCase() === origin)
      : undefined;
    for (const recipient of rows.filter((u) => !u.isRemote)) {
      const adders = creator ? [creator] : rows.filter((u) => u.id !== recipient.id);
      for (const adder of adders) {
        if (!(await canContact(recipient, adder))) return res.status(403).json({ error: "contact_not_allowed" });
      }
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
  // A community invitation card. Not validated here: a card that does not parse is dropped and the
  // message arrives as the text it also carries, rather than the peer losing the message.
  invite: z.unknown().optional(),
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
      invite: parseInvite(parsed.data.invite) ?? undefined,
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

/** Keeps the previews another server sent for a message (checked) and tells this server's people. Does nothing on a server with previews off. */
async function keepEmbeds(message: { id: string; conversationId: string | null; channelId: string | null; protocolId: string }, sent: unknown[]) {
  if (!config.linkPreviewsEnabled) return;
  const embeds = parseEmbeds(sent);
  await prisma.message.update({ where: { id: message.id }, data: { embeds: embeds.length > 0 ? (embeds as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
  const { recipients, location } = await localMessageRecipients(message);
  await emitSyncEvent(recipients, "message:embeds", { messageId: message.protocolId, embeds, ...location });
}

const incomingMessageEditSchema = z.object({ content: z.string().min(1).max(8000) });

federationRouter.post("/messages/:id/edit", async (req, res) => {
  const parsed = incomingMessageEditSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const message = await prisma.message.findUnique({ where: { protocolId: param(req, "id") }, include: { sender: true } });
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

// The link previews of a message, as its own server read them (#197). Sent separately from the message, after it, because reading the
// pages takes a moment and the message must not wait. This server never reads the pages: it checks what it is told (parseEmbeds
// drops anything that is not a plain preview of an http(s) address and cuts the text), and only the message's own server may say.
// A server that does no previews ignores it, so "off" means no cards at all. A server that predates it answers 404, which the
// sender's outbox records as rejected and does not retry.
const incomingEmbedsSchema = z.object({ embeds: z.array(z.unknown()).max(50) });

federationRouter.post("/messages/:id/embeds", async (req, res) => {
  const parsed = incomingEmbedsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const message = await prisma.message.findUnique({ where: { protocolId: param(req, "id") }, include: { sender: true } });
  if (!message || message.deletedAt || message.conversationId === null) return res.status(404).json({ error: "not_found" });
  if (message.sender.homeserverDomain !== req.federationOrigin) return res.status(403).json({ error: "not_message_owner" });
  await keepEmbeds(message, parsed.data.embeds);
  res.status(204).end();
});

// A person on the sender's server deleted their account (#60): forget them (modules/users/deletion.ts: their messages here, their
// friendships and memberships, leaving a tombstone). Only a person's OWN server may say so, judged by the origin that signed this
// request against the home server this one has cached for them, so no server can erase anyone else's people. Answered 204 for someone
// this server has never heard of or has already forgotten (it is sent to every server that might know them, and may be sent twice),
// which also means a request naming one of OUR accounts is a quiet nothing, never a way to find out whether it exists.
const incomingAccountDeletedSchema = z.object({ protocolId: z.string().min(1).max(100) });

federationRouter.post("/account-deleted", async (req, res) => {
  const parsed = incomingAccountDeletedSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const stub = await prisma.user.findUnique({ where: { protocolId: parsed.data.protocolId } });
  if (!stub || !stub.isRemote || stub.deletedAt) return res.status(204).end();
  if (stub.homeserverDomain.toLowerCase() !== req.federationOrigin!.toLowerCase()) return res.status(403).json({ error: "not_account_home" });
  await forgetRemoteUser(stub);
  res.status(204).end();
});

federationRouter.post("/messages/:id/delete", async (req, res) => {
  const message = await prisma.message.findUnique({ where: { protocolId: param(req, "id") }, include: { sender: true } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
  if (message.sender.homeserverDomain !== req.federationOrigin) {
    return res.status(403).json({ error: "not_message_owner" });
  }

  await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
  const { recipients, location } = await localMessageRecipients(message);
  await emitSyncEvent(recipients, "message:deleted", { messageId: message.protocolId, ...location });
  res.status(204).end();
});

// A reaction is a Unicode `emoji`, or a custom `emoticon` (its id, name and an absolute picture URL) which also
// carries an `emoji` text fallback for servers that predate them (#110); at least one of the two.
const incomingReactionSchema = z
  .object({
    fromDomain: z.string().min(1),
    fromProtocolId: z.string().min(1),
    fromUsername: z.string().min(1),
    ...wireReactionShape,
  })
  .refine(hasReaction);

// The reaction a validated request names (the schemas above guarantee there is one).
const reactionOf = (data: { emoji?: string; emoticon?: EmoticonRef }): ReactionKind => reactionFromWire(data)!;

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

  const message = await prisma.message.findUnique({ where: { protocolId: param(req, "id") } });
  if (!message || message.deletedAt || !message.conversationId) return res.status(404).json({ error: "not_found" });

  const reactor = await resolveReactor(parsed.data);

  // Verify the reactor is actually a member of this message's conversation,
  // rather than trusting the payload outright - same pattern POST
  // /messages already uses for a message's sender.
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: message.conversationId, userId: reactor.id } },
  });
  if (!membership) return res.status(403).json({ error: "not_a_member" });

  await addReaction(message.id, reactor.id, reactionOf(parsed.data));

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

  const message = await prisma.message.findUnique({ where: { protocolId: param(req, "id") } });
  if (!message || !message.conversationId) return res.status(404).json({ error: "not_found" });

  const reactor = await resolveReactor(parsed.data);

  await removeReaction(message.id, reactor.id, reactionOf(parsed.data));

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

// --- Communities ------------------------------------------------------------
//
// A community has exactly one authoritative home server, unlike a DM/group
// conversation where every member server is a peer - see
// protocol/federation.md's "Communities" section for the full trust model.
// Every handler below starts the same way: resolve the community, then
// branch on `community.isRemote` to tell which of two opposite roles we're
// playing for this specific community (the real home, or just a member's
// cache of one we don't own) before doing anything else.

const incomingCommunityMemberSchema = z.object({
  protocolId: z.string().min(1),
  username: z.string().min(1),
  displayName: z.string().min(1).optional(),
  avatarUrl: z.string().nullable().optional(),
  // The invite the person joins with, if any (src/lib/invites.ts). Optional: an older server sends none, which
  // works while the community lets anyone join.
  inviteCode: z.string().regex(INVITE_CODE_PATTERN).optional(),
});

// Whether this person may join is decided HERE, on the community's home server, by joinLocalCommunity: a ban, an
// invite (its expiry, uses and revocation) or the community being open to anyone. The joining user's
// domain is deliberately never read from the body, only from
// req.federationOrigin - a peer can only ever vouch for its own users.
federationRouter.post("/communities/:id/members", async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "not_community_home" });

  const parsed = incomingCommunityMemberSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const member = await ensureRemoteUser({
    protocolId: parsed.data.protocolId,
    username: parsed.data.username,
    domain: req.federationOrigin!,
    displayName: parsed.data.displayName ?? parsed.data.username,
    avatarUrl: parsed.data.avatarUrl,
  });

  const joined = await joinLocalCommunity(community, { id: member.id, isRemote: true }, parsed.data.inviteCode);
  if (!joined.ok) return res.status(joined.status).json({ error: joined.error });

  res.status(201).json({ community: await buildCommunitySnapshot(community.id) });
});

const incomingInviteSchema = createInviteSchema.extend({
  username: z.string().min(1),
  viaCard: z.boolean().optional(),
});

// A member on another server makes an invite (a card sent to their friend, or one from the Invite dialog). Only this
// server knows the invites, so their server asks here: the person must be a member of this community who holds
// CREATE_INVITE. As always the person's domain is the caller's own, never taken from the body.
federationRouter.post("/communities/:id/invites", async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "not_community_home" });

  const parsed = incomingInviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const user = await prisma.user.findUnique({
    where: { username_homeserverDomain: { username: parsed.data.username, homeserverDomain: req.federationOrigin! } },
  });
  const membership = user
    ? await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: user.id } } })
    : null;
  if (!user || !membership) return res.status(403).json({ error: "not_a_member" });
  // An invite from someone on another server is for a person anywhere, and none of them could use it here.
  if (!acceptsOtherServers(effectiveVisibility(community.visibility, config.communityVisibilityLimit))) return res.status(403).json({ error: "community_local_only" });

  const perms = await getMemberPermissions(community.id, user.id, community.ownerId);
  if (!hasPermission(perms, Permission.CREATE_INVITE)) return res.status(403).json({ error: "forbidden" });

  const invite = await createInvite({
    communityId: community.id,
    createdById: user.id,
    expiresInSeconds: parsed.data.expiresInSeconds,
    maxUses: parsed.data.maxUses,
    viaCard: parsed.data.viaCard,
  });
  res.status(201).json({
    invite: { code: invite.code, expiresAt: invite.expiresAt, maxUses: invite.maxUses, createdAt: invite.createdAt },
  });
});

const incomingCommunityLeaveSchema = z.object({ username: z.string().min(1) });

federationRouter.post("/communities/:id/members/leave", async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "not_community_home" });

  const parsed = incomingCommunityLeaveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  // Idempotent, no-error-if-already-gone - mirrors local leave's own
  // deleteMany-with-no-existence-check semantics.
  const member = await prisma.user.findUnique({
    where: { username_homeserverDomain: { username: parsed.data.username, homeserverDomain: req.federationOrigin! } },
  });
  if (member) {
    const { count } = await prisma.communityMember.deleteMany({ where: { communityId: community.id, userId: member.id } });
    if (count > 0) await notifyLocalMembersOfUpdate(community.id);
  }
  res.status(204).end();
});

/**
 * What a server with no member in a community is told when it asks about it (its snapshot, or who is in it): "you have no member
 * here", which is also what tells a server whose last member left to drop its cache. For a community that takes only accounts
 * from its own server it is the answer for an id nobody has, so it cannot be confirmed to exist.
 */
function notAMemberDomain(community: { visibility: CommunityVisibility }, res: Response) {
  if (!acceptsOtherServers(effectiveVisibility(community.visibility, config.communityVisibilityLimit))) return res.status(404).json({ error: "not_found" });
  return res.status(403).json({ error: "not_a_member_domain" });
}

federationRouter.get("/communities/:id", async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "not_community_home" });

  // Don't let an uninvolved peer probe a community's structure - require
  // the caller's domain to already have a member here. Joining is open/
  // unrestricted today, so this isn't a hard privacy boundary, just a
  // "you have to have actually joined first" gate - and it doubles as the
  // "am I still welcome" check the /updated resync handler below relies
  // on: once this domain has no members left, this starts returning 403,
  // which is exactly the signal that tells a remote server to drop its cache.
  const hasMember = await prisma.communityMember.findFirst({
    where: { communityId: community.id, user: { homeserverDomain: req.federationOrigin!, isRemote: true } },
  });
  if (!hasMember) return notAMemberDomain(community, res);

  res.json({ community: await buildCommunitySnapshot(community.id) });
});

// A member on another server reporting a message in, or the whole of, a community hosted here (#58, docs/content-reports.md). The member's
// own server only carries it: THIS server reads the message from its own copy and runs the same checks as for a local report
// (`createReport`), so what the moderators see is never what another server says it is. Nobody is told, least of all the person reported.
// The not-found code is its own (`report_target_not_found`), never the generic `not_found`: that is what a server that has never heard of
// this endpoint answers, and the sending server relies on telling the two apart.
const incomingReportSchema = z.object({
  username: z.string().min(1).max(100),
  kind: z.enum(["message", "community"]),
  id: z.string().min(1).max(100),
  reason: z.enum(REPORT_REASONS),
  details: z.string().max(500).optional(),
});

const CARRIED_REPORT_STATUS = { not_found: 404, cannot_report_self: 400, already_reported: 409, too_many_reports: 429 } as const;

federationRouter.post("/communities/:id/reports", async (req, res) => {
  const parsed = incomingReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "report_target_not_found" });
  if (community.isRemote) return res.status(409).json({ error: "not_community_home" });
  // A server with no member here is told the same as for something that does not exist, so this cannot be used to find communities
  // (stricter than the snapshot, which says it has no member there).
  const hasMember = await prisma.communityMember.findFirst({
    where: { communityId: community.id, user: { homeserverDomain: req.federationOrigin!, isRemote: true } },
    select: { id: true },
  });
  if (!hasMember) return res.status(404).json({ error: "report_target_not_found" });
  const reporter = await resolveExistingCommunityMember(community.id, req.federationOrigin!, parsed.data.username);
  if (!reporter) return res.status(403).json({ error: "not_a_member" });

  const result = await createReport(
    reporter,
    { kind: parsed.data.kind, id: parsed.data.id, reason: parsed.data.reason, details: parsed.data.details },
    { inCommunity: community.protocolId }
  );
  if (!result.ok) {
    // `remote_community` and the relay errors cannot happen here: this is the home server, and nothing is carried on.
    const status = CARRIED_REPORT_STATUS[result.error as keyof typeof CARRIED_REPORT_STATUS] ?? 404;
    return res.status(status).json({ error: result.error === "not_found" ? "report_target_not_found" : result.error });
  }
  res.status(201).json({ received: true });
});

// This server's directory (#109 phase 5): the communities it lists as PUBLIC and the people who chose to be listed, for another
// server's people to browse through their own. Answered only when this server publishes one (DIRECTORY_ENABLED); otherwise it
// says so, which is not a secret (the discovery document says it too) and lets the asker tell "none here" from "unreachable".
federationRouter.get("/directory/communities", async (req, res) => {
  if (!config.directoryEnabled) return res.status(404).json({ error: "directory_disabled" });
  const query = parseDirectoryQuery(req.query);
  if (!query.ok) return res.status(400).json({ error: "invalid_request" });
  res.json(await listPublicCommunities(query.q, query.cursor));
});

federationRouter.get("/directory/people", async (req, res) => {
  if (!config.directoryEnabled) return res.status(404).json({ error: "directory_disabled" });
  const query = parseDirectoryQuery(req.query);
  if (!query.ok) return res.status(400).json({ error: "invalid_request" });
  res.json(await listListedPeople(query.q, query.cursor));
});

// Whether someone is a member of a community hosted here: the answer to "do these two people share a community?" for a server whose
// member holds a community hosted elsewhere and so only knows its own members. Gated like the snapshot above (only a server that
// already has a member here may ask), and it tells that server nothing it could not already see in the member list.
federationRouter.get("/communities/:id/membership", async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.isRemote) return res.status(409).json({ error: "not_community_home" });

  const hasMember = await prisma.communityMember.findFirst({
    where: { communityId: community.id, user: { homeserverDomain: req.federationOrigin!, isRemote: true } },
  });
  if (!hasMember) return notAMemberDomain(community, res);

  const username = typeof req.query.username === "string" ? req.query.username : "";
  const domain = typeof req.query.domain === "string" ? req.query.domain : "";
  if (username === "" || domain === "") return res.status(400).json({ error: "invalid_request" });

  const member = await prisma.communityMember.findFirst({
    where: { communityId: community.id, user: { username, homeserverDomain: { equals: domain, mode: "insensitive" } } },
    select: { id: true },
  });
  res.json({ member: member !== null });
});

// Received by a REMOTE member's own server, pushed by the home server
// whenever something structural changed (channel created/renamed,
// community renamed, a member's role/membership changed) - deliberately
// one unified "re-sync" signal rather than a granular event per
// change-type. Reacting is just re-fetching the current snapshot, which is
// self-healing under reordering by construction (see
// communities/routes.ts's notifyRemoteMembersOfUpdate for the full
// reasoning) - no sequence number needed.
federationRouter.post("/communities/:id/updated", async (req, res) => {
  const community = await resolveCommunity(param(req, "id"));
  if (!community || !community.isRemote) return res.status(204).end();
  if (req.federationOrigin !== community.homeserverDomain) {
    return res.status(403).json({ error: "not_community_home" });
  }

  // Captured before any delete below - there's nothing left to query once
  // the row (and its cascaded CommunityMember rows) is gone.
  const localMemberIds = (await prisma.communityMember.findMany({ where: { communityId: community.id } })).map(
    (m) => m.userId
  );

  try {
    const response = await proxyToHomeServer<{ community: CommunitySnapshot }>(
      community.homeserverDomain,
      `/communities/${community.protocolId}`,
      { method: "GET" }
    );
    await applyCommunitySnapshot(response.community, community.homeserverDomain);
  } catch (err) {
    if (err instanceof FederationProxyError && (err.status === 403 || err.status === 404)) {
      // 403: no local user on our domain is a member anymore (kicked/banned/
      // left on the home side). 404: the home server deleted the community.
      // Either way drop the cache rather than leaving a stale, inaccessible
      // community sitting in someone's list forever.
      await prisma.community.delete({ where: { id: community.id } });
    }
    // Any other failure (home server briefly unreachable) just leaves the
    // cache stale until the next successful resync - not fatal.
  }

  // Tell the affected local client(s) to refresh, whether the cache was
  // updated or dropped - see client/src/context/AppDataContext.tsx.
  await emitSyncEvent(localMemberIds, "community:updated", {});
  res.status(204).end();
});

const incomingCommunityMessageSchema = z.object({
  messageId: z.string().min(1),
  fromProtocolId: z.string().min(1),
  fromUsername: z.string().min(1),
  fromDomain: z.string().min(1),
  content: z.string().min(1).max(8000),
  createdAt: z.string().or(z.date()).optional(),
  attachments: z.array(incomingAttachmentSchema).max(10).optional(),
});

/**
 * Resolves a community message's sender/reactor. Unlike a group DM
 * (potentially many legitimate member domains), a community message has
 * exactly one authority - its home server - so there's no third
 * "independently verify a third party" case: the actor is either us (the
 * relay looped back to our own domain, harmless per
 * localMessageRecipients' philosophy - must resolve to our REAL local
 * user, never upsert a stub over it) or the real home server's own local
 * user (ensureRemoteUser as normal). Anything else is rejected outright.
 */
async function resolveCommunityActor(
  fromDomain: string,
  fromProtocolId: string,
  fromUsername: string,
  federationOrigin: string
): Promise<string | null> {
  if (fromDomain === config.domain) {
    const local = await findLocalUserByUsername(fromUsername);
    return local?.id ?? null;
  }
  if (fromDomain === federationOrigin) {
    const actor = await ensureRemoteUser({
      protocolId: fromProtocolId,
      username: fromUsername,
      domain: fromDomain,
      displayName: fromUsername,
    });
    return actor.id;
  }
  return null;
}

/**
 * Resolves a member a peer claims is proxying an action - requires an
 * EXISTING cached User (keyed on `username` + the authenticated
 * `domain`, never trusted from elsewhere in the payload) with an EXISTING
 * CommunityMember row for this community. Deliberately never
 * auto-creates anything here (unlike join's `ensureRemoteUser`) - if they
 * were never actually introduced via a real join, they get no benefit of
 * the doubt, since this path is what every other mutating action trusts
 * to mean "this is genuinely one of our members."
 */
async function resolveExistingCommunityMember(communityId: string, domain: string, username: string) {
  const user = await prisma.user.findUnique({
    where: { username_homeserverDomain: { username, homeserverDomain: domain } },
  });
  if (!user) return null;
  const membership = await prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId: user.id } },
  });
  return membership ? user : null;
}

/**
 * Relays a community message action to every remote member's domain -
 * INCLUDING the acting member's own domain. Confirmed by hand on the real
 * two-server demo that excluding it (the original design) is a real bug,
 * not just unnecessary caution: the proxy caller
 * (channels/routes.ts, messages/routes.ts) does no local write of its
 * own, relying entirely on this relay to persist the result into the
 * acting member's own server. Their CLIENT shows the result immediately
 * from the direct HTTP response either way, but that's in-memory React
 * state, not the same thing as their SERVER's database - excluding their
 * domain here meant their own next page load (or a second session) found
 * nothing, because nothing had ever actually been written there.
 */
async function relayToRemoteDomains(communityId: string, path: string, body: unknown) {
  const domains = await getRemoteCommunityDomains(communityId);
  for (const domain of domains) {
    await enqueueFederationEvent(domain, path, body);
  }
}

const incomingCommunitySendSchema = z.object({
  username: z.string().min(1),
  content: z.string().min(1).max(8000),
  replyToId: z.string().optional(),
  attachments: z.array(incomingAttachmentSchema).max(10).optional(),
});

federationRouter.post("/communities/:communityId/channels/:channelId/messages", async (req, res) => {
  const community = await resolveCommunity(param(req, "communityId"));
  if (!community) return res.status(404).json({ error: "not_found" });

  if (!community.isRemote) {
    // We're the real home - a remote member's own server proxying a send
    // on their behalf. Run the real SEND_MESSAGES check against their
    // actual role, write it, and relay onward - mirrors
    // channels/routes.ts's local send handler as closely as possible so
    // the response shape matches exactly what that proxy caller expects
    // to pass straight through to its own client.
    const parsed = incomingCommunitySendSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

    const actor = await resolveExistingCommunityMember(community.id, req.federationOrigin!, parsed.data.username);
    if (!actor) return res.status(403).json({ error: "not_a_member" });

    const perms = await getMemberPermissions(community.id, actor.id, community.ownerId);
    if (!hasPermission(perms, Permission.SEND_MESSAGES)) return res.status(403).json({ error: "forbidden" });

    const channel = await prisma.channel.findUnique({ where: { protocolId: param(req, "channelId") } });
    if (!channel || channel.communityId !== community.id) return res.status(404).json({ error: "channel_not_found" });
    if (channel.type !== "TEXT") return res.status(409).json({ error: "not_a_text_channel" });

    let replyToId: string | undefined;
    if (parsed.data.replyToId) {
      const replyTo = await prisma.message.findUnique({ where: { protocolId: parsed.data.replyToId } });
      if (replyTo && replyTo.channelId === channel.id) replyToId = replyTo.id;
    }

    const message = await prisma.message.create({
      data: {
        protocolId: newProtocolId(),
        channelId: channel.id,
        senderId: actor.id,
        content: parsed.data.content,
        replyToId,
        attachments: parsed.data.attachments ? { create: parsed.data.attachments } : undefined,
      },
      include: messageInclude,
    });

    const senderEmoticons = await getAccessibleEmoticons(actor.id);
    const serialized = serializeMessage(message as any, senderEmoticons);
    const { recipients, location } = await localMessageRecipients(message);
    await emitSyncEvent(recipients, "message:created", { message: serialized, ...location });

    const absoluteAttachments = message.attachments.map((a) => ({
      url: toAbsoluteMediaUrl(a.url, config.baseUrl),
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    }));
    await relayToRemoteDomains(
      community.id,
      `/communities/${community.protocolId}/channels/${channel.protocolId}/messages`,
      {
        messageId: message.protocolId,
        fromProtocolId: actor.protocolId,
        fromUsername: actor.username,
        fromDomain: req.federationOrigin,
        content: message.content,
        createdAt: message.createdAt,
        attachments: absoluteAttachments,
      }
    );

    return res.status(201).json({ message: serialized });
  }

  // We're just a cache - this must be a passive relay FROM the real home
  // server, never a send request, since we don't own this community. This
  // check is what stops an unrelated peer from injecting fake messages
  // into our cached copy of someone else's community.
  if (req.federationOrigin !== community.homeserverDomain) {
    return res.status(403).json({ error: "not_community_home" });
  }

  const parsed = incomingCommunityMessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const channel = await prisma.channel.findUnique({ where: { protocolId: param(req, "channelId") } });
  if (!channel || channel.communityId !== community.id) return res.status(404).json({ error: "channel_not_found" });

  const senderId = await resolveCommunityActor(
    parsed.data.fromDomain,
    parsed.data.fromProtocolId,
    parsed.data.fromUsername,
    req.federationOrigin!
  );
  if (!senderId) return res.status(403).json({ error: "sender_domain_mismatch" });

  const message = await prisma.message.upsert({
    where: { protocolId: parsed.data.messageId },
    create: {
      protocolId: parsed.data.messageId,
      channelId: channel.id,
      senderId,
      content: parsed.data.content,
      createdAt: parsed.data.createdAt ? new Date(parsed.data.createdAt) : undefined,
      attachments: parsed.data.attachments ? { create: parsed.data.attachments } : undefined,
    },
    update: {},
    include: messageInclude,
  });

  const senderEmoticons = await getAccessibleEmoticons(senderId);
  const serialized = serializeMessage(message as any, senderEmoticons);
  const { recipients, location } = await localMessageRecipients(message);
  await emitSyncEvent(recipients, "message:created", { message: serialized, ...location });
  res.status(201).json({ ok: true });
});

const incomingCommunityEditSchema = z.object({ username: z.string().min(1), content: z.string().min(1).max(8000) });

// The same for a message in a channel of a community that lives on the sender's server (this server holds a copy).
federationRouter.post("/communities/:communityId/channels/:channelId/messages/:messageId/embeds", async (req, res) => {
  const community = await resolveCommunity(param(req, "communityId"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (!community.isRemote || req.federationOrigin !== community.homeserverDomain) return res.status(403).json({ error: "not_community_home" });
  const parsed = incomingEmbedsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const channel = await prisma.channel.findFirst({ where: { protocolId: param(req, "channelId"), communityId: community.id } });
  const message = channel ? await prisma.message.findUnique({ where: { protocolId: param(req, "messageId") } }) : null;
  if (!channel || !message || message.deletedAt || message.channelId !== channel.id) return res.status(404).json({ error: "not_found" });
  await keepEmbeds(message, parsed.data.embeds);
  res.status(204).end();
});

federationRouter.post("/communities/:communityId/channels/:channelId/messages/:messageId/edit", async (req, res) => {
  const community = await resolveCommunity(param(req, "communityId"));
  if (!community) return res.status(404).json({ error: "not_found" });

  if (!community.isRemote) {
    // Real home: a remote member's server proxying an edit of THEIR OWN
    // message. Sender-only, no permission bit - matches messages/routes.ts's
    // local edit handler exactly (it has never supported a moderator
    // override either).
    const parsed = incomingCommunityEditSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

    const actor = await resolveExistingCommunityMember(community.id, req.federationOrigin!, parsed.data.username);
    if (!actor) return res.status(403).json({ error: "not_a_member" });

    const message = await prisma.message.findUnique({ where: { protocolId: param(req, "messageId") } });
    if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
    if (message.senderId !== actor.id) return res.status(403).json({ error: "forbidden" });

    const updated = await prisma.message.update({
      where: { id: message.id },
      data: { content: parsed.data.content, editedAt: new Date() },
      include: messageInclude,
    });
    const senderEmoticons = await getAccessibleEmoticons(message.senderId);
    const serialized = serializeMessage(updated as any, senderEmoticons);
    const { recipients, location } = await localMessageRecipients(message);
    await emitSyncEvent(recipients, "message:edited", { message: serialized, ...location });

    await relayToRemoteDomains(
      community.id,
      `/communities/${community.protocolId}/channels/${param(req, "channelId")}/messages/${message.protocolId}/edit`,
      { content: parsed.data.content }
    );

    return res.json({ message: serialized });
  }

  if (req.federationOrigin !== community.homeserverDomain) {
    return res.status(403).json({ error: "not_community_home" });
  }

  const parsed = incomingMessageEditSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const message = await prisma.message.findUnique({ where: { protocolId: param(req, "messageId") } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });

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

const incomingCommunityDeleteSchema = z.object({ username: z.string().min(1) });

federationRouter.post("/communities/:communityId/channels/:channelId/messages/:messageId/delete", async (req, res) => {
  const community = await resolveCommunity(param(req, "communityId"));
  if (!community) return res.status(404).json({ error: "not_found" });

  if (!community.isRemote) {
    const parsed = incomingCommunityDeleteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

    const actor = await resolveExistingCommunityMember(community.id, req.federationOrigin!, parsed.data.username);
    if (!actor) return res.status(403).json({ error: "not_a_member" });

    const message = await prisma.message.findUnique({ where: { protocolId: param(req, "messageId") } });
    if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
    // The message must live in this community and channel, whatever ids the caller put in the URL.
    if (!(await messageIsInCommunity(message, community.id, param(req, "channelId")))) {
      return res.status(404).json({ error: "not_found" });
    }
    if (message.senderId !== actor.id) {
      // Someone else's message: only a member holding DELETE_MESSAGES here, in the community's real home.
      const perms = await getMemberPermissions(community.id, actor.id, community.ownerId);
      if (!hasPermission(perms, Permission.DELETE_MESSAGES)) return res.status(403).json({ error: "forbidden" });
    }

    await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
    if (message.senderId !== actor.id) {
      const channel = await prisma.channel.findFirst({ where: { protocolId: param(req, "channelId"), communityId: community.id } });
      await recordAudit({
        source: "api",
        action: "message.delete",
        actor: { kind: "user", user: actor },
        community,
        target: { type: "message", id: message.protocolId },
        details: { channel: channel?.name ?? null },
      });
    }
    const { recipients, location } = await localMessageRecipients(message);
    await emitSyncEvent(recipients, "message:deleted", { messageId: message.protocolId, ...location });

    await relayToRemoteDomains(
      community.id,
      `/communities/${community.protocolId}/channels/${param(req, "channelId")}/messages/${message.protocolId}/delete`,
      {}
    );

    return res.status(204).end();
  }

  if (req.federationOrigin !== community.homeserverDomain) {
    return res.status(403).json({ error: "not_community_home" });
  }

  const message = await prisma.message.findUnique({ where: { protocolId: param(req, "messageId") } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });

  await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
  const { recipients, location } = await localMessageRecipients(message);
  await emitSyncEvent(recipients, "message:deleted", { messageId: message.protocolId, ...location });
  res.status(204).end();
});

const incomingCommunityReactSchema = z.object({ username: z.string().min(1), ...wireReactionShape }).refine(hasReaction);

federationRouter.post("/communities/:communityId/channels/:channelId/messages/:messageId/reactions", async (req, res) => {
  const community = await resolveCommunity(param(req, "communityId"));
  if (!community) return res.status(404).json({ error: "not_found" });

  if (!community.isRemote) {
    // Real home: the REACT permission (in the default member role) gates adding a reaction, the same
    // as the local react handler (messages/routes.ts).
    const parsed = incomingCommunityReactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

    const actor = await resolveExistingCommunityMember(community.id, req.federationOrigin!, parsed.data.username);
    if (!actor) return res.status(403).json({ error: "not_a_member" });

    const message = await prisma.message.findUnique({ where: { protocolId: param(req, "messageId") } });
    if (!message || message.deletedAt || !message.channelId) return res.status(404).json({ error: "not_found" });
    if (!(await messageIsInCommunity(message, community.id, param(req, "channelId")))) {
      return res.status(404).json({ error: "not_found" });
    }
    const reactPerms = await getMemberPermissions(community.id, actor.id, community.ownerId);
    if (!hasPermission(reactPerms, Permission.REACT)) return res.status(403).json({ error: "forbidden" });

    await addReaction(message.id, actor.id, reactionOf(parsed.data));

    const updated = await prisma.message.findUnique({ where: { id: message.id }, include: messageInclude });
    const senderEmoticons = await getAccessibleEmoticons(message.senderId);
    const serialized = serializeMessage(updated as any, senderEmoticons);
    const { recipients, location } = await localMessageRecipients(message);
    await emitSyncEvent(recipients, "message:reaction_added", {
      messageId: message.protocolId,
      reactions: serialized.reactions,
      ...location,
    });

    await relayToRemoteDomains(
      community.id,
      `/communities/${community.protocolId}/channels/${param(req, "channelId")}/messages/${message.protocolId}/reactions`,
      { fromDomain: req.federationOrigin, fromProtocolId: actor.protocolId, fromUsername: actor.username, ...reactionWire(reactionOf(parsed.data)) }
    );

    return res.json({ message: serialized });
  }

  if (req.federationOrigin !== community.homeserverDomain) {
    return res.status(403).json({ error: "not_community_home" });
  }

  const parsed = incomingReactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const message = await prisma.message.findUnique({ where: { protocolId: param(req, "messageId") } });
  if (!message || message.deletedAt || !message.channelId) return res.status(404).json({ error: "not_found" });

  const reactorId = await resolveCommunityActor(
    parsed.data.fromDomain,
    parsed.data.fromProtocolId,
    parsed.data.fromUsername,
    req.federationOrigin!
  );
  if (!reactorId) return res.status(403).json({ error: "sender_domain_mismatch" });

  await addReaction(message.id, reactorId, reactionOf(parsed.data));

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

federationRouter.post(
  "/communities/:communityId/channels/:channelId/messages/:messageId/reactions/remove",
  async (req, res) => {
    const community = await resolveCommunity(param(req, "communityId"));
    if (!community) return res.status(404).json({ error: "not_found" });

    if (!community.isRemote) {
      const parsed = incomingCommunityReactSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

      const actor = await resolveExistingCommunityMember(community.id, req.federationOrigin!, parsed.data.username);
      if (!actor) return res.status(403).json({ error: "not_a_member" });

      const message = await prisma.message.findUnique({ where: { protocolId: param(req, "messageId") } });
      if (!message || !message.channelId) return res.status(404).json({ error: "not_found" });

      await removeReaction(message.id, actor.id, reactionOf(parsed.data));

      const updated = await prisma.message.findUnique({ where: { id: message.id }, include: messageInclude });
      const senderEmoticons = await getAccessibleEmoticons(message.senderId);
      const serialized = serializeMessage(updated as any, senderEmoticons);
      const { recipients, location } = await localMessageRecipients(message);
      await emitSyncEvent(recipients, "message:reaction_removed", {
        messageId: message.protocolId,
        reactions: serialized.reactions,
        ...location,
      });

      await relayToRemoteDomains(
        community.id,
        `/communities/${community.protocolId}/channels/${param(req, "channelId")}/messages/${message.protocolId}/reactions/remove`,
        { fromDomain: req.federationOrigin, fromProtocolId: actor.protocolId, fromUsername: actor.username, ...reactionWire(reactionOf(parsed.data)) }
      );

      return res.json({ message: serialized });
    }

    if (req.federationOrigin !== community.homeserverDomain) {
      return res.status(403).json({ error: "not_community_home" });
    }

    const parsed = incomingReactionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

    const message = await prisma.message.findUnique({ where: { protocolId: param(req, "messageId") } });
    if (!message || !message.channelId) return res.status(404).json({ error: "not_found" });

    const reactorId = await resolveCommunityActor(
      parsed.data.fromDomain,
      parsed.data.fromProtocolId,
      parsed.data.fromUsername,
      req.federationOrigin!
    );
    if (!reactorId) return res.status(403).json({ error: "sender_domain_mismatch" });

    await removeReaction(message.id, reactorId, reactionOf(parsed.data));

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
  }
);

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
