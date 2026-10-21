import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { hashPassword } from "../../lib/auth.js";
import { disableTotp } from "../auth/totp.js";
import { deleteCommunity } from "../communities/deleteCommunity.js";
import { purgeDate } from "../../lib/accountDeletionGrace.js";
import { cancelDeletion, purgeAccount, requestDeletion, type OwnedCommunity } from "../users/deletion.js";
import { OPERATOR, recordAudit, ERASED_LABEL, type AuditActor } from "../audit/service.js";
import type { AuditSource } from "../../lib/auditActions.js";
import { identityFor } from "../../lib/ids.js";
import { literally } from "../../lib/likeSearch.js";

// What an operator can do to this server's accounts and communities (#128). Plain functions over the database, so the admin
// command (cli/admin.ts) and, later, an admin page (#206) share one set of rules instead of each writing their own.
//
// METADATA ONLY, on purpose: nothing here reads a message, a direct message, a channel or an attachment, and nothing returns a
// password hash, a TOTP secret, a recovery code or a token. A summary is built field by field (never by spreading a database row),
// so a column added to User later cannot leak into the output by accident.

/**
 * Who is doing it and where from, for the audit log (#59). The command line is the default, and the admin page passes the admin who is
 * signed in. Every function here that changes something writes its entry itself, so the two front ends cannot differ in what they record.
 */
export interface AdminContext {
  actor: AuditActor;
  source: AuditSource;
}
export const CLI_CONTEXT: AdminContext = { actor: OPERATOR, source: "cli" };

const accountTarget = (user: { protocolId: string; username: string; homeserverDomain: string }) => ({
  type: "user",
  id: user.protocolId,
  label: identityFor(user.username, user.homeserverDomain),
});

export interface UserSummary {
  /** The person's id, which is also how they are named in the audit log. */
  id: string;
  username: string;
  identity: string;
  displayName: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  twoFactor: boolean;
  suspended: boolean;
  /** Whether they may use the admin page. */
  admin: boolean;
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
  protocolId: string;
  username: string;
  displayName: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  totpEnabled: boolean;
  suspendedAt: Date | null;
  deletionRequestedAt: Date | null;
  isAdmin: boolean;
  _count: { ownedCommunities: number; communityMemberships: number };
}): UserSummary {
  return {
    id: user.protocolId,
    username: user.username,
    identity: identityOf(user.username, config.domain),
    displayName: user.displayName,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    twoFactor: user.totpEnabled,
    suspended: user.suspendedAt !== null,
    admin: user.isAdmin,
    deletionPending: user.deletionRequestedAt !== null,
    communitiesOwned: user._count.ownedCommunities,
    // Membership includes the ones they own.
    communitiesJoined: user._count.communityMemberships,
  };
}

const COUNTS = { select: { ownedCommunities: true, communityMemberships: true } } as const;

export interface UserListOptions {
  search?: string;
  suspendedOnly?: boolean;
  /** Only accounts that are admins, or only those that are not. */
  admin?: boolean;
}

function userFilter(options: UserListOptions) {
  const search = options.search?.trim();
  return {
    ...LOCAL,
    ...(options.suspendedOnly ? { suspendedAt: { not: null } } : {}),
    ...(options.admin !== undefined ? { isAdmin: options.admin } : {}),
    ...(search ? { OR: [{ username: { contains: literally(search), mode: "insensitive" as const } }, { displayName: { contains: literally(search), mode: "insensitive" as const } }] } : {}),
  };
}

const USER_SUMMARY_SELECT = {
  protocolId: true,
  username: true,
  displayName: true,
  createdAt: true,
  lastSeenAt: true,
  totpEnabled: true,
  suspendedAt: true,
  deletionRequestedAt: true,
  isAdmin: true,
  _count: COUNTS,
} as const;

/** Every account that matches, oldest first (the command's list). */
export async function listUsers(options: UserListOptions = {}): Promise<UserSummary[]> {
  const users = await prisma.user.findMany({ where: userFilter(options), orderBy: { createdAt: "asc" }, select: USER_SUMMARY_SELECT });
  return users.map(summarize);
}

export const MAX_USER_PAGE = 100;

/** One page of the list, oldest first, and how many match in all (the admin page's list). */
export async function listUsersPage(options: UserListOptions & { offset?: number; limit?: number } = {}): Promise<{ users: UserSummary[]; total: number }> {
  const where = userFilter(options);
  // A limit that is not a whole number of 1 or more is not a limit: the usual page, never a page of one or of everything.
  const asked = Math.trunc(options.limit ?? 25);
  const take = Number.isFinite(asked) && asked >= 1 ? Math.min(asked, MAX_USER_PAGE) : 25;
  const skip = Math.max(Math.trunc(options.offset ?? 0) || 0, 0);
  const [users, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip, take, select: USER_SUMMARY_SELECT }),
    prisma.user.count({ where }),
  ]);
  return { users: users.map(summarize), total };
}

export async function getUser(username: string): Promise<UserDetail | null> {
  const found = await findLocalUserByUsername(username);
  if (!found) return null;
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: found.id },
    select: {
      protocolId: true,
      username: true,
      displayName: true,
      createdAt: true,
      lastSeenAt: true,
      totpEnabled: true,
      suspendedAt: true,
      deletionRequestedAt: true,
      isAdmin: true,
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

export async function suspendUser(username: string, ctx: AdminContext = CLI_CONTEXT): Promise<AccountResult<{ changed: boolean; sessionsEnded: number }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  const changed = user.suspendedAt === null;
  if (changed) await prisma.user.update({ where: { id: user.id }, data: { suspendedAt: new Date() } });
  // Revoked even when it was already suspended, so running it again never leaves a session behind.
  const sessionsEnded = await revokeSessions(user.id);
  if (changed) await recordAudit({ ...ctx, action: "user.suspend", target: accountTarget(user), details: { sessionsEnded } });
  return { ok: true, changed, sessionsEnded };
}

export async function unsuspendUser(username: string, ctx: AdminContext = CLI_CONTEXT): Promise<AccountResult<{ changed: boolean }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  if (user.suspendedAt === null) return { ok: true, changed: false };
  await prisma.user.update({ where: { id: user.id }, data: { suspendedAt: null } });
  await recordAudit({ ...ctx, action: "user.unsuspend", target: accountTarget(user) });
  return { ok: true, changed: true };
}

/** Sets a new password and ends every session. The caller has already checked it against the password policy. */
export async function resetPassword(username: string, password: string, ctx: AdminContext = CLI_CONTEXT): Promise<AccountResult<{ sessionsEnded: number }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
  const sessionsEnded = await revokeSessions(user.id);
  // Never the password, or anything about it.
  await recordAudit({ ...ctx, action: "user.reset_password", target: accountTarget(user), details: { sessionsEnded } });
  return { ok: true, sessionsEnded };
}

/** The way back in for someone who lost their authenticator and recovery codes. Their sessions are left alone. */
export async function disableTwoFactor(username: string, ctx: AdminContext = CLI_CONTEXT): Promise<AccountResult<{ wasEnabled: boolean }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  if (user.totpEnabled) {
    await disableTotp(user.id);
    await recordAudit({ ...ctx, action: "user.disable_2fa", target: accountTarget(user) });
  }
  return { ok: true, wasEnabled: user.totpEnabled };
}

/**
 * Makes someone an admin (may use the admin page, #206) or takes it away. The one place this changes: the operator's command, and the admin
 * page for an admin passing it on. The API never takes it from a request body, so a stolen ordinary session cannot promote itself. An
 * account that is a stub of someone else's, or erased, is not found. Whether they can USE it also needs two-factor sign-in, which is
 * said back so the operator is told.
 */
export async function setAdmin(username: string, admin: boolean, ctx: AdminContext = CLI_CONTEXT): Promise<AccountResult<{ changed: boolean; twoFactor: boolean }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  const changed = user.isAdmin !== admin;
  if (changed) {
    await prisma.user.update({ where: { id: user.id }, data: { isAdmin: admin } });
    await recordAudit({ ...ctx, action: admin ? "user.admin_grant" : "user.admin_revoke", target: accountTarget(user) });
  }
  return { ok: true, changed, twoFactor: user.totpEnabled };
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
export async function deleteUser(username: string, options: { now?: boolean } = {}, ctx: AdminContext = CLI_CONTEXT): Promise<DeleteUserResult> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  if (options.now) {
    const result = await purgeAccount(user.id);
    if (result.ok) {
      // The person's name is gone from the log by now (purgeAccount erases it), so the entry is about the id.
      await recordAudit({ ...ctx, action: "account.erase", target: { type: "user", id: user.protocolId, label: ERASED_LABEL } });
      return { ok: true, mode: "erased" };
    }
    return result.error === "owns_communities" ? result : { ok: false, error: "no_such_user" };
  }
  const result = await requestDeletion(user.id);
  if (result.ok) {
    if (!result.alreadyRequested) await recordAudit({ ...ctx, action: "account.delete_request", target: accountTarget(user), details: { scheduledFor: result.scheduledFor.toISOString() } });
    return { ok: true, mode: "scheduled", scheduledFor: result.scheduledFor, alreadyRequested: result.alreadyRequested };
  }
  return result.error === "owns_communities" ? result : { ok: false, error: "no_such_user" };
}

/** Takes a pending deletion back, without waiting for the person to sign in. */
export async function cancelUserDeletion(username: string, ctx: AdminContext = CLI_CONTEXT): Promise<AccountResult<{ changed: boolean }>> {
  const user = await findLocalUserByUsername(username);
  if (!user) return { ok: false, error: "no_such_user" };
  const changed = await cancelDeletion(user.id);
  if (changed) await recordAudit({ ...ctx, action: "account.delete_cancel", target: accountTarget(user) });
  return { ok: true, changed };
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
export async function deleteCommunityByOperator(id: string, ctx: AdminContext = CLI_CONTEXT): Promise<DeleteResult> {
  const community = await prisma.community.findUnique({ where: { protocolId: id } });
  if (!community) return { ok: false, error: "no_such_community" };
  // A cached copy of another server's community is theirs: deleting our copy would only be undone by their next update.
  if (community.isRemote) return { ok: false, error: "not_hosted_here" };
  await deleteCommunity(community);
  await recordAudit({ ...ctx, action: "community.delete", community, target: { type: "community", id: community.protocolId, label: community.name } });
  return { ok: true };
}
