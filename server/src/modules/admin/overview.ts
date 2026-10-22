import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { serverVersion } from "../../lib/version.js";
import { listRegistrationInvites } from "./registrationInvites.js";
import { LOCAL } from "./service.js";

// The admin page's overview (#206): what this server is, how it is set up and how busy it is, at a glance. COUNTS AND SWITCHES ONLY: no message,
// no direct message, no name of anyone or of any community, no address of a person, and no secret (nothing from the environment that is not a
// plain setting an operator chose: never a key, a password, a URL with credentials, or a list of who is allowed). Built field by field, so a new
// column or setting cannot reach the page by accident. Every number is for THIS server: its own accounts and the communities it hosts.

const DAY_MS = 86_400_000;

export interface Overview {
  generatedAt: Date;
  server: {
    name: string;
    domain: string;
    version: string;
    storage: "disk" | "s3";
    /** Whether several replicas can share the realtime parts through Redis (REDIS_URL is set). */
    redis: boolean;
  };
  registration: { enabled: boolean; inviteOnly: boolean; activeInvites: number };
  features: { federation: boolean; voice: boolean; directory: boolean; linkPreviews: boolean };
  federation: {
    enabled: boolean;
    /** How many servers are named in each list that limits who this one talks to (0 and 0: no limit). The names are not shown. */
    allowedServers: number;
    blockedServers: number;
    /** Other servers this one has looked up so far. */
    knownServers: number;
    queue: { pending: number; retrying: number; inProgress: number; failed: number; oldestPendingAt: Date | null };
  };
  people: {
    total: number;
    activeLastDay: number;
    activeLastWeek: number;
    activeLastMonth: number;
    joinedLastWeek: number;
    suspended: number;
    deletionPending: number;
    admins: number;
    withoutTwoFactor: number;
  };
  communities: {
    hosted: number;
    /** Copies of communities on other servers that people here are in. */
    copiesOfOthers: number;
    memberships: number;
    textChannels: number;
    voiceChannels: number;
    byVisibility: { UNLISTED: number; PUBLIC: number; INVITE_ONLY: number; LOCAL_ONLY: number };
  };
  /** Entries written to the audit log in the last day. */
  auditEntriesLastDay: number;
  /** The settings that shape the server and what each is now, by the name of the environment variable that sets it. Read at startup: changing one takes a restart. */
  settings: { setting: string; value: string }[];
}

/** The settings in effect, as plain words. Each is a choice an operator made, never a secret. */
export function settingsInEffect(): { setting: string; value: string }[] {
  return [
    { setting: "ACCOUNT_DELETION_GRACE_DAYS", value: String(config.accountDeletionGraceDays) },
    { setting: "AUDIT_LOG_RETENTION_DAYS", value: String(config.auditLogRetentionDays) },
    { setting: "COMMUNITY_VISIBILITY_DEFAULT", value: config.communityVisibilityDefault },
    { setting: "COMMUNITY_VISIBILITY_LIMIT", value: config.communityVisibilityLimit },
    { setting: "FEDERATION_CONTACT_POLICY_DEFAULT", value: config.contactPolicyDefault },
    { setting: "FEDERATION_CONTACT_POLICY_LIMIT", value: config.contactPolicyLimit },
    { setting: "FEDERATION_USER_DISCOVERABILITY", value: config.userDiscoverability },
    { setting: "DIRECTORY_PEOPLE", value: config.directoryPeople },
    { setting: "MAX_UPLOAD_BYTES", value: String(config.maxUploadBytes) },
  ];
}

export async function getOverview(now: Date = new Date()): Promise<Overview> {
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
  // The accounts of THIS server: the one definition the users section uses (no cached copy of someone elsewhere, no erased account).
  const people = LOCAL;
  const hosted = { isRemote: false } as const;

  const [
    total,
    activeLastDay,
    activeLastWeek,
    activeLastMonth,
    joinedLastWeek,
    suspended,
    deletionPending,
    admins,
    withoutTwoFactor,
    hostedCount,
    copiesOfOthers,
    memberships,
    textChannels,
    voiceChannels,
    visibilities,
    knownServers,
    outbox,
    retrying,
    oldestPending,
    auditEntriesLastDay,
    invites,
  ] = await Promise.all([
    prisma.user.count({ where: people }),
    prisma.user.count({ where: { ...people, lastSeenAt: { gte: since(1) } } }),
    prisma.user.count({ where: { ...people, lastSeenAt: { gte: since(7) } } }),
    prisma.user.count({ where: { ...people, lastSeenAt: { gte: since(30) } } }),
    prisma.user.count({ where: { ...people, createdAt: { gte: since(7) } } }),
    prisma.user.count({ where: { ...people, suspendedAt: { not: null } } }),
    prisma.user.count({ where: { ...people, deletionRequestedAt: { not: null } } }),
    prisma.user.count({ where: { ...people, isAdmin: true } }),
    prisma.user.count({ where: { ...people, totpEnabled: false } }),
    prisma.community.count({ where: hosted }),
    prisma.community.count({ where: { isRemote: true } }),
    prisma.communityMember.count({ where: { community: hosted } }),
    prisma.channel.count({ where: { community: hosted, type: "TEXT" } }),
    prisma.channel.count({ where: { community: hosted, type: "VOICE" } }),
    prisma.community.groupBy({ by: ["visibility"], where: hosted, _count: { _all: true } }),
    prisma.federationPeer.count(),
    prisma.federationOutboxEvent.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.federationOutboxEvent.count({ where: { status: "PENDING", attempts: { gt: 0 } } }),
    prisma.federationOutboxEvent.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.auditLogEntry.count({ where: { createdAt: { gte: since(1) } } }),
    listRegistrationInvites(),
  ]);

  const byStatus = (status: "PENDING" | "IN_PROGRESS" | "FAILED") => outbox.find((row) => row.status === status)?._count._all ?? 0;
  const byVisibility = { UNLISTED: 0, PUBLIC: 0, INVITE_ONLY: 0, LOCAL_ONLY: 0 };
  for (const row of visibilities) if (row.visibility in byVisibility) byVisibility[row.visibility as keyof typeof byVisibility] = row._count._all;

  return {
    generatedAt: now,
    server: { name: config.serverName, domain: config.domain, version: serverVersion, storage: config.storageDriver, redis: Boolean(config.redisUrl) },
    registration: { enabled: config.registrationEnabled, inviteOnly: config.registrationEnabled && config.registrationInviteOnly, activeInvites: invites.total },
    features: { federation: config.federationEnabled, voice: config.voice.enabled, directory: config.directoryEnabled, linkPreviews: config.linkPreviewsEnabled },
    federation: {
      enabled: config.federationEnabled,
      allowedServers: config.federationPolicy.allowed.length,
      blockedServers: config.federationPolicy.blocked.length,
      knownServers,
      queue: { pending: byStatus("PENDING"), retrying, inProgress: byStatus("IN_PROGRESS"), failed: byStatus("FAILED"), oldestPendingAt: oldestPending?.createdAt ?? null },
    },
    people: { total, activeLastDay, activeLastWeek, activeLastMonth, joinedLastWeek, suspended, deletionPending, admins, withoutTwoFactor },
    communities: { hosted: hostedCount, copiesOfOthers, memberships, textChannels, voiceChannels, byVisibility },
    auditEntriesLastDay,
    settings: settingsInEffect(),
  };
}
