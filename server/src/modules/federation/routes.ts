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
import { localMessageRecipients, getRemoteCommunityDomains } from "../messages/federationRelay.js";
import { sendToUsers } from "../../ws/gateway.js";
import { MAX_GROUP_MEMBERS } from "../../lib/conversations.js";
import { resolveCommunity, getMemberPermissions } from "../communities/routes.js";
import { applyCommunitySnapshot, buildCommunitySnapshot, type CommunitySnapshot } from "./communitySnapshot.js";
import { FederationProxyError, proxyToHomeServer } from "../../lib/federation/proxy.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";
import { newProtocolId } from "../../lib/ids.js";

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
});

// Joining is open in this MVP on the local side too (see
// communities/routes.ts) - the only gate here is a ban. The joining user's
// domain is deliberately never read from the body, only from
// req.federationOrigin - a peer can only ever vouch for its own users.
federationRouter.post("/communities/:id/members", async (req, res) => {
  const community = await resolveCommunity(req.params.id);
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

  const banned = await prisma.communityBan.findUnique({
    where: { communityId_userId: { communityId: community.id, userId: member.id } },
  });
  if (banned) return res.status(403).json({ error: "banned" });

  const everyoneRole = await prisma.role.findFirst({ where: { communityId: community.id, isDefault: true } });
  const membership = await prisma.communityMember.upsert({
    where: { communityId_userId: { communityId: community.id, userId: member.id } },
    create: { communityId: community.id, userId: member.id },
    update: {},
  });
  if (everyoneRole) {
    await prisma.memberRole.upsert({
      where: { memberId_roleId: { memberId: membership.id, roleId: everyoneRole.id } },
      create: { memberId: membership.id, roleId: everyoneRole.id },
      update: {},
    });
  }

  res.status(201).json({ community: await buildCommunitySnapshot(community.id) });
});

const incomingCommunityLeaveSchema = z.object({ username: z.string().min(1) });

federationRouter.post("/communities/:id/members/leave", async (req, res) => {
  const community = await resolveCommunity(req.params.id);
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
    await prisma.communityMember.deleteMany({ where: { communityId: community.id, userId: member.id } });
  }
  res.status(204).end();
});

federationRouter.get("/communities/:id", async (req, res) => {
  const community = await resolveCommunity(req.params.id);
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
  if (!hasMember) return res.status(403).json({ error: "not_a_member_domain" });

  res.json({ community: await buildCommunitySnapshot(community.id) });
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
  const community = await resolveCommunity(req.params.id);
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
    if (err instanceof FederationProxyError && err.status === 403) {
      // No local user on our domain is a member anymore (kicked/banned/
      // left on the home side) - drop the cache rather than leaving a
      // stale, inaccessible community sitting in someone's list forever.
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
  const community = await resolveCommunity(req.params.communityId);
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

    const channel = await prisma.channel.findUnique({ where: { protocolId: req.params.channelId } });
    if (!channel || channel.communityId !== community.id) return res.status(404).json({ error: "channel_not_found" });

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

  const channel = await prisma.channel.findUnique({ where: { protocolId: req.params.channelId } });
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

federationRouter.post("/communities/:communityId/channels/:channelId/messages/:messageId/edit", async (req, res) => {
  const community = await resolveCommunity(req.params.communityId);
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

    const message = await prisma.message.findUnique({ where: { protocolId: req.params.messageId } });
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
      `/communities/${community.protocolId}/channels/${req.params.channelId}/messages/${message.protocolId}/edit`,
      { content: parsed.data.content }
    );

    return res.json({ message: serialized });
  }

  if (req.federationOrigin !== community.homeserverDomain) {
    return res.status(403).json({ error: "not_community_home" });
  }

  const parsed = incomingMessageEditSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const message = await prisma.message.findUnique({ where: { protocolId: req.params.messageId } });
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
  const community = await resolveCommunity(req.params.communityId);
  if (!community) return res.status(404).json({ error: "not_found" });

  if (!community.isRemote) {
    const parsed = incomingCommunityDeleteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

    const actor = await resolveExistingCommunityMember(community.id, req.federationOrigin!, parsed.data.username);
    if (!actor) return res.status(403).json({ error: "not_a_member" });

    const message = await prisma.message.findUnique({ where: { protocolId: req.params.messageId } });
    if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
    if (message.senderId !== actor.id) return res.status(403).json({ error: "forbidden" });

    await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
    const { recipients, location } = await localMessageRecipients(message);
    await emitSyncEvent(recipients, "message:deleted", { messageId: message.protocolId, ...location });

    await relayToRemoteDomains(
      community.id,
      `/communities/${community.protocolId}/channels/${req.params.channelId}/messages/${message.protocolId}/delete`,
      {}
    );

    return res.status(204).end();
  }

  if (req.federationOrigin !== community.homeserverDomain) {
    return res.status(403).json({ error: "not_community_home" });
  }

  const message = await prisma.message.findUnique({ where: { protocolId: req.params.messageId } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });

  await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
  const { recipients, location } = await localMessageRecipients(message);
  await emitSyncEvent(recipients, "message:deleted", { messageId: message.protocolId, ...location });
  res.status(204).end();
});

const incomingCommunityReactSchema = z.object({ username: z.string().min(1), emoji: z.string().min(1).max(32) });

federationRouter.post("/communities/:communityId/channels/:channelId/messages/:messageId/reactions", async (req, res) => {
  const community = await resolveCommunity(req.params.communityId);
  if (!community) return res.status(404).json({ error: "not_found" });

  if (!community.isRemote) {
    // Real home: membership is the only gate, same as the local react
    // handler (messages/routes.ts) - no REACT permission bit is enforced
    // anywhere in this codebase today, so this doesn't invent one just
    // for the remote case.
    const parsed = incomingCommunityReactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

    const actor = await resolveExistingCommunityMember(community.id, req.federationOrigin!, parsed.data.username);
    if (!actor) return res.status(403).json({ error: "not_a_member" });

    const message = await prisma.message.findUnique({ where: { protocolId: req.params.messageId } });
    if (!message || message.deletedAt || !message.channelId) return res.status(404).json({ error: "not_found" });

    await prisma.reaction.upsert({
      where: { messageId_userId_emoji: { messageId: message.id, userId: actor.id, emoji: parsed.data.emoji } },
      create: { messageId: message.id, userId: actor.id, emoji: parsed.data.emoji },
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

    await relayToRemoteDomains(
      community.id,
      `/communities/${community.protocolId}/channels/${req.params.channelId}/messages/${message.protocolId}/reactions`,
      { fromDomain: req.federationOrigin, fromProtocolId: actor.protocolId, fromUsername: actor.username, emoji: parsed.data.emoji }
    );

    return res.json({ message: serialized });
  }

  if (req.federationOrigin !== community.homeserverDomain) {
    return res.status(403).json({ error: "not_community_home" });
  }

  const parsed = incomingReactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const message = await prisma.message.findUnique({ where: { protocolId: req.params.messageId } });
  if (!message || message.deletedAt || !message.channelId) return res.status(404).json({ error: "not_found" });

  const reactorId = await resolveCommunityActor(
    parsed.data.fromDomain,
    parsed.data.fromProtocolId,
    parsed.data.fromUsername,
    req.federationOrigin!
  );
  if (!reactorId) return res.status(403).json({ error: "sender_domain_mismatch" });

  await prisma.reaction.upsert({
    where: { messageId_userId_emoji: { messageId: message.id, userId: reactorId, emoji: parsed.data.emoji } },
    create: { messageId: message.id, userId: reactorId, emoji: parsed.data.emoji },
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

federationRouter.post(
  "/communities/:communityId/channels/:channelId/messages/:messageId/reactions/remove",
  async (req, res) => {
    const community = await resolveCommunity(req.params.communityId);
    if (!community) return res.status(404).json({ error: "not_found" });

    if (!community.isRemote) {
      const parsed = incomingCommunityReactSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

      const actor = await resolveExistingCommunityMember(community.id, req.federationOrigin!, parsed.data.username);
      if (!actor) return res.status(403).json({ error: "not_a_member" });

      const message = await prisma.message.findUnique({ where: { protocolId: req.params.messageId } });
      if (!message || !message.channelId) return res.status(404).json({ error: "not_found" });

      await prisma.reaction.deleteMany({
        where: { messageId: message.id, userId: actor.id, emoji: parsed.data.emoji },
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

      await relayToRemoteDomains(
        community.id,
        `/communities/${community.protocolId}/channels/${req.params.channelId}/messages/${message.protocolId}/reactions/remove`,
        { fromDomain: req.federationOrigin, fromProtocolId: actor.protocolId, fromUsername: actor.username, emoji: parsed.data.emoji }
      );

      return res.json({ message: serialized });
    }

    if (req.federationOrigin !== community.homeserverDomain) {
      return res.status(403).json({ error: "not_community_home" });
    }

    const parsed = incomingReactionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

    const message = await prisma.message.findUnique({ where: { protocolId: req.params.messageId } });
    if (!message || !message.channelId) return res.status(404).json({ error: "not_found" });

    const reactorId = await resolveCommunityActor(
      parsed.data.fromDomain,
      parsed.data.fromProtocolId,
      parsed.data.fromUsername,
      req.federationOrigin!
    );
    if (!reactorId) return res.status(403).json({ error: "sender_domain_mismatch" });

    await prisma.reaction.deleteMany({
      where: { messageId: message.id, userId: reactorId, emoji: parsed.data.emoji },
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
