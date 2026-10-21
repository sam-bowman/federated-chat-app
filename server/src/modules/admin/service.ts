import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { hashPassword } from "../../lib/auth.js";
import { disableTotp } from "../auth/totp.js";
import { deleteCommunity } from "../communities/deleteCommunity.js";
import { purgeDate } from "../../lib/accountDeletionGrace.js";
import { cancelDeletion, purgeAccount, requestDeletion, type OwnedCommunity } from "../users/deletion.js";

// What an operator can do to this server's accounts and communities (#128). Plain functions over the database, so the admin
// command (cli/admin.ts) and, later, an admin page (#206) share one set of rules instead of each writing their own.
//
// METADATA ONLY, on purpose: nothing here reads a message, a direct message, a channel or an attachment, and nothing returns a
// password hash, a TOTP secret, a recovery code or a token. A summary is built field by field (never by spreading a database row),
// so a column added to User later cannot leak into the output by accident.

export interface UserSummary {
  username: string;
  identity: string;
  displayName: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  twoFactor: boolean;
  suspended: boolean;
  /** True while the person (or the operator) has asked for the account to be deleted and the grace period is running. */
  deletionPending: boolean;
  communitiesOwned: number;
  communitiesJoined: number;
}

export interface UserDetail extends UserSummary {
  suspendedAt: Date | null;
  /** When deletion was asked for, and when the account will be erased if nobody signs in first. Null when it was not asked for. */
  deletionRequestedAt: Date | null;
  deletionScheduledFor: Date | null;
  /** Sessions that could still be refreshed. */
  activeSessions: number;
  ownedCommunities: { id: string; name: string }[];
  /** The note on the registration invite this account was made with, if it was made with one. */
  registrationInviteNote: string | null;
}

export interface CommunitySummary {
  id: string;
  name: string;
  /** "here": hosted on this server. "cached": a copy of a community on another server, which is not ours to manage. */
  hosting: "here" | "cached";
  hostedBy: string;
  owner: string;
  members: number;
  channels: number;
  visibility: string;
  createdAt: Date;
}

export interface CommunityDetail extends CommunitySummary {
  description: string | null;
  localMembers: number;
  remoteMembers: number;
  textChannels: number;
  voiceChannels: number;
  remoteDomains: string[];
}

const identityOf = (username: string, domain: string) => `@${username}:${domain}`;

/** Local accounts only: a remote stub is a cached copy of someone else's account. An erased account (a tombstone) is not an account any more. */
const LOCAL = { isRemote: false, homeserverDomain: config.domain, deletedAt: null } as const;

function summarize(user: {
  username: string;
  displayName: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  totpEnabled: boolean;
  suspendedAt: Date | null;
  deletionRequestedAt: Date | null;
  _count: { ownedCommunities: number; communityMemberships: number };
}): UserSummary {
  return {
    username: user.username,
    identity: identityOf(user.username, config.domain),
    displayName: user.displayName,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    twoFactor: user.totpEnabled,
    suspended: user.suspendedAt !== null,
    deletionPending: user.deletionRequestedAt !== null,
    communitiesOwned: user._count.ownedCommunities,
    // Membership includes the ones they own.
    communitiesJoined: user._count.communityMemberships,
  };
}

const COUNTS = { select: { ownedCommunities: true, communityMemberships: true } } as const;

export async function listUsers(options: { search?: string; suspendedOnly?: boolean } = {}): Promise<UserSummary[]> {
  const search = options.search?.trim();
  const users = await prisma.user.findMany({
    where: {
      ...LOCAL,
      ...(options.suspendedOnly ? { suspendedAt: { not: null } } : {}),
      ...(search ? { OR: [{ username: { contains: search, mode: "insensitive" } }, { displayName: { contains: search, mode: "insensitive" } }] } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { username: true, displayName: true, createdAt: true, lastSeenAt: true, totpEnabled: true, suspendedAt: true, deletionRequestedAt: true, _count: COUNTS },
  });
  return users.map(summarize);
}

export async function getUser(username: string): Promise<UserDetail | null> {
  const found = await findLocalUserByUsername(username);
  if (!found) return null;
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: found.id },
    select: {
      username: true,
      displayName: true,
      createdAt: true,
      lastSeenAt: true,
      totpEnabled: true,
      suspendedAt: true,
      deletionRequestedAt: true,
      _count: COUNTS,
      ownedCommunities: { select: { protocolId: true, name: true }, orderBy: { createdAt: "asc" } },
      registrationInvite: { select: { note: true } },
    },
  });
  const activeSessions = await prisma.refreshToken.count({ where: { userId: found.id, revokedAt: null, expiresAt: { gt: new Date() } } });
  return {
    ...summarize(user),
    suspendedAt: user.suspendedAt,
    deletionRequestedAt: user.deletionRequestedAt,
    deletionScheduledFor: user.deletionRequestedAt ? purgeDate(user.deletionRequestedAt, config.accountDeletionGraceDays) : null,
    activeSessions,
    ownedCommunities: user.ownedCommunities.map((c) => ({ id: c.protocolId, name: c.name })),
    registrationInviteNote: user.registrationInvite?.note ?? null,
  };
}

/** Ends every session the account could refresh. (An access token already issued stays good until it expires, 15 minutes at most.) */
async function revokeSessions(userId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return result.count;
}

export type AccountResult<T = object> = ({ ok: true } & T) | { ok: false; error: "no_such_user" };

export async function suspendUser(username: string): Promise<AccountResult<{ changed: boolean; sessionsEnded: number }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  const changed = user.suspendedAt === null;
  if (changed) await prisma.user.update({ where: { id: user.id }, data: { suspendedAt: new Date() } });
  // Revoked even when it was already suspended, so running it again never leaves a session behind.
  return { ok: true, changed, sessionsEnded: await revokeSessions(user.id) };
}

export async function unsuspendUser(username: string): Promise<AccountResult<{ changed: boolean }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  if (user.suspendedAt === null) return { ok: true, changed: false };
  await prisma.user.update({ where: { id: user.id }, data: { suspendedAt: null } });
  return { ok: true, changed: true };
}

/** Sets a new password and ends every session. The caller has already checked it against the password policy. */
export async function resetPassword(username: string, password: string): Promise<AccountResult<{ sessionsEnded: number }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
  return { ok: true, sessionsEnded: await revokeSessions(user.id) };
}

/** The way back in for someone who lost their authenticator and recovery codes. Their sessions are left alone. */
export async function disableTwoFactor(username: string): Promise<AccountResult<{ wasEnabled: boolean }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  if (user.totpEnabled) await disableTotp(user.id);
  return { ok: true, wasEnabled: user.totpEnabled };
}

export type DeleteUserResult =
  | { ok: true; mode: "scheduled"; scheduledFor: Date; alreadyRequested: boolean }
  | { ok: true; mode: "erased" }
  | { ok: false; error: "no_such_user" }
  | { ok: false; error: "owns_communities"; communities: OwnedCommunity[] };

/**
 * Deletes an account (#60): by default it is only ASKED for, exactly as if the person had asked (sessions end, the grace period
 * starts, signing in cancels it). With `now` it is erased at once. Either way an account that owns a community is refused, so no
 * community is left without an owner behind anyone's back: transfer it (the owner) or delete it (`communities delete`) first.
 */
export async function deleteUser(username: string, options: { now?: boolean } = {}): Promise<DeleteUserResult> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  if (options.now) {
    const result = await purgeAccount(user.id);
    if (result.ok) return { ok: true, mode: "erased" };
    return result.error === "owns_communities" ? result : { ok: false, error: "no_such_user" };
  }
  const result = await requestDeletion(user.id);
  if (result.ok) return { ok: true, mode: "scheduled", scheduledFor: result.scheduledFor, alreadyRequested: result.alreadyRequested };
  return result.error === "owns_communities" ? result : { ok: false, error: "no_such_user" };
}

/** Takes a pending deletion back, without waiting for the person to sign in. */
export async function cancelUserDeletion(username: string): Promise<AccountResult<{ changed: boolean }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  return { ok: true, changed: await cancelDeletion(user.id) };
}

const COMMUNITY_SELECT = {
  protocolId: true,
  name: true,
  description: true,
  isRemote: true,
  homeserverDomain: true,
  visibility: true,
  createdAt: true,
  owner: { select: { username: true, homeserverDomain: true } },
  _count: { select: { members: true, channels: true } },
} as const;

type CommunityRow = {
  protocolId: string;
  name: string;
  isRemote: boolean;
  homeserverDomain: string;
  visibility: string;
  createdAt: Date;
  owner: { username: string; homeserverDomain: string };
  _count: { members: number; channels: number };
};

function summarizeCommunity(c: CommunityRow): CommunitySummary {
  return {
    id: c.protocolId,
    name: c.name,
    hosting: c.isRemote ? "cached" : "here",
    hostedBy: c.homeserverDomain,
    owner: identityOf(c.owner.username, c.owner.homeserverDomain),
    members: c._count.members,
    channels: c._count.channels,
    visibility: c.visibility,
    createdAt: c.createdAt,
  };
}

export async function listCommunities(): Promise<CommunitySummary[]> {
  const rows = await prisma.community.findMany({ orderBy: { createdAt: "asc" }, select: COMMUNITY_SELECT });
  return rows.map(summarizeCommunity);
}

export async function getCommunity(id: string): Promise<CommunityDetail | null> {
  const row = await prisma.community.findUnique({ where: { protocolId: id }, select: COMMUNITY_SELECT });
  if (!row) return null;
  const [local, remote, text, voice, domains] = await Promise.all([
    prisma.communityMember.count({ where: { community: { protocolId: id }, user: { isRemote: false } } }),
    prisma.communityMember.count({ where: { community: { protocolId: id }, user: { isRemote: true } } }),
    prisma.channel.count({ where: { community: { protocolId: id }, type: "TEXT" } }),
    prisma.channel.count({ where: { community: { protocolId: id }, type: "VOICE" } }),
    prisma.user.findMany({ where: { isRemote: true, communityMemberships: { some: { community: { protocolId: id } } } }, distinct: ["homeserverDomain"], select: { homeserverDomain: true } }),
  ]);
  return {
    ...summarizeCommunity(row),
    description: row.description,
    localMembers: local,
    remoteMembers: remote,
    textChannels: text,
    voiceChannels: voice,
    remoteDomains: domains.map((d) => d.homeserverDomain).sort(),
  };
}

export type DeleteResult = { ok: true } | { ok: false; error: "no_such_community" | "not_hosted_here" };

/** Deletes a community this server hosts, exactly as its owner deleting it would (see modules/communities/deleteCommunity.ts). */
export async function deleteCommunityByOperator(id: string): Promise<DeleteResult> {
  const community = await prisma.community.findUnique({ where: { protocolId: id } });
  if (!community) return { ok: false, error: "no_such_community" };
  // A cached copy of another server's community is theirs: deleting our copy would only be undone by their next update.
  if (community.isRemote) return { ok: false, error: "not_hosted_here" };
  await deleteCommunity(community);
  return { ok: true };
}
