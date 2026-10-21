import type { User } from "@prisma/client";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { purgeDate } from "../../lib/accountDeletionGrace.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { collectUserMediaUrls, deleteUnreferencedMedia } from "../communities/communityMedia.js";
import { notifyLocalMembersOfUpdate } from "../communities/notifyMembers.js";
import { emitSyncEvent } from "../sync/events.js";
import { disconnectFromCall, disconnectFromVoice } from "../voice/service.js";

// Deleting an account (#60, part 2). Three steps, so a mistake or a stolen session is never permanent in one click:
//
//   1. The person (or the operator) ASKS: `requestDeletion` records when and ends every session. Nothing else changes, and nobody else
//      can tell. Refused while they own a community, since that would leave it without an owner: they transfer or delete it first.
//   2. Signing in again CANCELS it (`cancelDeletion`, called by the login routes), until the grace period (ACCOUNT_DELETION_GRACE_DAYS,
//      14 by default) has passed.
//   3. After that `purgeAccount` ERASES it, from the worker (`startAccountDeletionWorker`) or at once for the operator.
//
// What erasure leaves behind is a TOMBSTONE, not a deleted row: other people's rows point at the account (an emoticon a community keeps,
// a direct message's other member), so the row stays with nothing of the person in it: name "Deleted user", no profile, no password, no
// memberships, no messages. Its username becomes one nobody can register, and the real one is kept in DeletedUsername so that nobody can
// take the name and be mistaken for them on a server that still remembers.

export type OwnedCommunity = { id: string; name: string };

/** What an account has to settle before it can be deleted: the communities it owns. A community is hosted here whenever a local person owns it. */
export async function ownedCommunities(userId: string): Promise<OwnedCommunity[]> {
  const rows = await prisma.community.findMany({ where: { ownerId: userId }, select: { protocolId: true, name: true }, orderBy: { createdAt: "asc" } });
  return rows.map((c) => ({ id: c.protocolId, name: c.name }));
}

async function revokeSessions(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export type RequestResult =
  | { ok: true; requestedAt: Date; scheduledFor: Date; alreadyRequested: boolean }
  | { ok: false; error: "no_such_user" }
  | { ok: false; error: "owns_communities"; communities: OwnedCommunity[] };

/**
 * Starts the clock. Asking again keeps the first date (so it cannot be pushed back by repeating it), and every session is ended
 * either way, so running it twice never leaves one behind. The caller has already checked who is asking.
 */
export async function requestDeletion(userId: string): Promise<RequestResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.isRemote || user.deletedAt) return { ok: false, error: "no_such_user" };
  const communities = await ownedCommunities(userId);
  if (communities.length > 0) return { ok: false, error: "owns_communities", communities };

  const alreadyRequested = user.deletionRequestedAt !== null;
  const requestedAt = user.deletionRequestedAt ?? new Date();
  if (!alreadyRequested) await prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: requestedAt } });
  await revokeSessions(userId);
  return { ok: true, requestedAt, scheduledFor: purgeDate(requestedAt, config.accountDeletionGraceDays), alreadyRequested };
}

/** Takes a pending request back. True when there was one. Never touches an account that has already been erased. */
export async function cancelDeletion(userId: string): Promise<boolean> {
  const result = await prisma.user.updateMany({
    where: { id: userId, deletionRequestedAt: { not: null }, deletedAt: null },
    data: { deletionRequestedAt: null },
  });
  return result.count > 0;
}

/** Everyone who has to be told an account is gone: this server's people (a live event) and other servers (a federation event). */
interface Reach {
  localUserIds: Set<string>;
  remoteDomains: Set<string>;
}

function addPerson(reach: Reach, person: { id: string; isRemote: boolean; homeserverDomain: string }): void {
  if (person.isRemote) reach.remoteDomains.add(person.homeserverDomain);
  else reach.localUserIds.add(person.id);
}

/**
 * Who knows this person: friends and people they have a request with, whoever shares a conversation with them, and everyone in
 * their communities (the host, for a community on another server). Gathered BEFORE the rows that say so are deleted.
 */
async function reachOf(userId: string): Promise<{ reach: Reach; hostedCommunityIds: string[] }> {
  const reach: Reach = { localUserIds: new Set(), remoteDomains: new Set() };
  const [friendships, requests, conversationMates, memberships] = await Promise.all([
    prisma.friendship.findMany({ where: { OR: [{ userId }, { friendId: userId }] }, include: { user: true, friend: true } }),
    prisma.friendRequest.findMany({ where: { OR: [{ fromUserId: userId }, { toUserId: userId }] }, include: { fromUser: true, toUser: true } }),
    prisma.conversationMember.findMany({ where: { userId: { not: userId }, conversation: { members: { some: { userId } } } }, include: { user: true } }),
    prisma.communityMember.findMany({ where: { userId }, include: { community: true } }),
  ]);
  for (const f of friendships) addPerson(reach, f.userId === userId ? f.friend : f.user);
  for (const r of requests) addPerson(reach, r.fromUserId === userId ? r.toUser : r.fromUser);
  for (const m of conversationMates) addPerson(reach, m.user);

  const hostedCommunityIds: string[] = [];
  for (const { community } of memberships) {
    if (community.isRemote) {
      // Their cached copy of someone else's community: its home server is the one that holds their membership and messages.
      reach.remoteDomains.add(community.homeserverDomain);
      continue;
    }
    hostedCommunityIds.push(community.id);
    const others = await prisma.communityMember.findMany({ where: { communityId: community.id, userId: { not: userId } }, include: { user: true } });
    for (const o of others) addPerson(reach, o.user);
  }
  reach.localUserIds.delete(userId);
  return { reach, hostedCommunityIds };
}

/** What a tombstone is: nothing of the person, and a name that says so. */
const ANONYMOUS = {
  displayName: "Deleted user",
  avatarUrl: null,
  bio: null,
  pronouns: null,
  accentColor: null,
  customStatus: null,
  lastSeenAt: null,
  presenceStatus: "OFFLINE",
  totpSecret: null,
  totpEnabled: false,
  totpLastUsedStep: null,
  discoverable: false,
  listedInDirectory: false,
  deletionRequestedAt: null,
  suspendedAt: null,
  registrationInviteId: null,
} as const;

/**
 * What both sides erase of a person who is gone: everything that is theirs or only about them. Messages go with their reactions and
 * attachments (the schema cascades those), and a reply to one just loses its quote. A direct message keeps its other member, who
 * then has the conversation with "Deleted user"; a group simply loses a member. Written for a transaction so the account is
 * either all gone or not at all.
 */
async function eraseRelations(tx: Tx, userId: string, options: { personal: boolean }): Promise<void> {
  await tx.message.deleteMany({ where: { senderId: userId } });
  await tx.reaction.deleteMany({ where: { userId } });
  await tx.communityBan.deleteMany({ where: { userId } });
  await tx.communityMember.deleteMany({ where: { userId } });
  await tx.channelRead.deleteMany({ where: { userId } });
  await tx.conversationMember.deleteMany({ where: { userId, conversation: { type: "GROUP" } } });
  await tx.friendship.deleteMany({ where: { OR: [{ userId }, { friendId: userId }] } });
  await tx.friendRequest.deleteMany({ where: { OR: [{ fromUserId: userId }, { toUserId: userId }] } });
  await tx.block.deleteMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] } });
  if (options.personal) {
    // Only a local account has these: a stub has no sessions, choices, emoticons or invites of its own on this server.
    await tx.emoticon.deleteMany({ where: { creatorId: userId, communityId: null } });
    await tx.invite.deleteMany({ where: { createdById: userId } });
    await tx.emoticonSave.deleteMany({ where: { userId } });
    await tx.notificationSetting.deleteMany({ where: { userId } });
    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.totpRecoveryCode.deleteMany({ where: { userId } });
    await tx.syncEvent.deleteMany({ where: { recipientId: userId } });
  }
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** A conversation nobody on this server is left in is of no use to it: it goes, with its messages. */
async function dropAbandonedConversations(conversationIds: string[]): Promise<void> {
  if (conversationIds.length === 0) return;
  await prisma.conversation.deleteMany({
    where: { id: { in: conversationIds }, members: { none: { user: { isRemote: false, deletedAt: null } } } },
  });
}

const TRANSACTION = { timeout: 120_000, maxWait: 10_000 } as const;

export type PurgeResult =
  | { ok: true }
  | { ok: false; error: "no_such_user" | "not_local" | "already_deleted" }
  | { ok: false; error: "owns_communities"; communities: OwnedCommunity[] };

/**
 * Erases a local account now (the worker, once the grace period is over, or the operator). The account becomes a tombstone; its
 * messages, memberships, friendships, sessions, files and choices are gone; other servers are told to forget it. Refuses an account
 * that still owns a community. Claiming the account at the start of the transaction means two replicas erasing the same one cannot
 * both do it.
 */
export async function purgeAccount(userId: string): Promise<PurgeResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, error: "no_such_user" };
  if (user.isRemote) return { ok: false, error: "not_local" };
  if (user.deletedAt) return { ok: false, error: "already_deleted" };
  const communities = await ownedCommunities(user.id);
  if (communities.length > 0) return { ok: false, error: "owns_communities", communities };

  // Everything below needs rows the erasure removes, so it is gathered first.
  const { reach, hostedCommunityIds } = await reachOf(user.id);
  const mediaUrls = await collectUserMediaUrls(user.id);
  const conversations = await prisma.conversationMember.findMany({ where: { userId: user.id }, include: { conversation: { select: { id: true, protocolId: true } } } });
  const username = user.username;

  const erased = await prisma.$transaction(async (tx) => {
    // Claimed first: whoever gets here second finds it already done.
    const claimed = await tx.user.updateMany({ where: { id: user.id, deletedAt: null }, data: { deletedAt: new Date() } });
    if (claimed.count === 0) return false;
    await eraseRelations(tx, user.id, { personal: true });
    await tx.deletedUsername.upsert({ where: { username }, create: { username }, update: {} });
    await tx.user.update({
      where: { id: user.id },
      data: { ...ANONYMOUS, username: `~deleted-${user.protocolId.toLowerCase()}`, passwordHash: null },
    });
    return true;
  }, TRANSACTION);
  if (!erased) return { ok: false, error: "already_deleted" };

  await dropAbandonedConversations(conversations.map((c) => c.conversation.id));
  // A call or voice channel they are in would otherwise go on without anyone being able to end it.
  for (const c of conversations) await disconnectFromCall(c.conversation.protocolId, user.protocolId);
  for (const communityId of hostedCommunityIds) await disconnectFromVoice(communityId, user.protocolId);

  await emitSyncEvent([...reach.localUserIds], "user:deleted", { userId: user.protocolId });
  for (const communityId of hostedCommunityIds) await notifyLocalMembersOfUpdate(communityId);
  for (const domain of reach.remoteDomains) await enqueueFederationEvent(domain, "/account-deleted", { protocolId: user.protocolId });
  await deleteUnreferencedMedia(mediaUrls);
  return { ok: true };
}

/**
 * A server was told (by the person's own server) that a person is gone. Forgets them the same way: their messages here, their
 * friendships and memberships, leaving a tombstone for the rows that still point at them. Safe to run twice, and only ever
 * called for a remote stub, so it can never touch a local account.
 */
export async function forgetRemoteUser(stub: User): Promise<void> {
  if (!stub.isRemote || stub.deletedAt) return;
  const { reach, hostedCommunityIds } = await reachOf(stub.id);
  const conversations = await prisma.conversationMember.findMany({ where: { userId: stub.id }, select: { conversationId: true } });

  const done = await prisma.$transaction(async (tx) => {
    const claimed = await tx.user.updateMany({ where: { id: stub.id, deletedAt: null }, data: { deletedAt: new Date() } });
    if (claimed.count === 0) return false;
    await eraseRelations(tx, stub.id, { personal: false });
    await tx.user.update({ where: { id: stub.id }, data: { ...ANONYMOUS, passwordHash: null } });
    return true;
  }, TRANSACTION);
  if (!done) return;

  await dropAbandonedConversations(conversations.map((c) => c.conversationId));
  await emitSyncEvent([...reach.localUserIds], "user:deleted", { userId: stub.protocolId });
  for (const communityId of hostedCommunityIds) await notifyLocalMembersOfUpdate(communityId);
}

/** Erases every account whose grace period is over. Returns how many were erased. One that cannot be erased does not stop the others. */
export async function purgeDueAccounts(now: Date = new Date(), graceDays: number = config.accountDeletionGraceDays): Promise<number> {
  const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);
  const due = await prisma.user.findMany({
    where: { isRemote: false, deletedAt: null, deletionRequestedAt: { not: null, lte: cutoff } },
    select: { id: true },
  });
  let erased = 0;
  for (const { id } of due) {
    try {
      const result = await purgeAccount(id);
      if (result.ok) erased++;
      // They became an owner while waiting (a community was handed to them): erasing would orphan it, so the request is dropped.
      else if (result.error === "owns_communities") await prisma.user.update({ where: { id }, data: { deletionRequestedAt: null } });
    } catch (err) {
      console.error("[account deletion] could not erase an account, will try again:", err);
    }
  }
  return erased;
}

/** Looks for accounts to erase shortly after start and then every hour. Returns the function that stops it. */
export function startAccountDeletionWorker(intervalMs = 60 * 60 * 1000): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    purgeDueAccounts()
      .catch((err) => console.error("[account deletion] worker failed:", err))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
