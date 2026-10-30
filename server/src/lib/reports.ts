// What a content report (#58, docs/content-reports.md) is made of: the reasons a person can give, the limits on what is kept, and the snapshots
// of what was reported. A snapshot is the one place the server keeps what someone wrote on purpose for review, so everything in it is cut to a
// size, cleaned of characters that could reorder or hide text, and built field by field (a column added to a table later is not copied into a
// report until someone decides it should be).
//
// Kept free of config.ts and database imports so it can be unit-tested on its own.

export const REPORT_KINDS = ["message", "user", "community"] as const;
export type ReportKindName = (typeof REPORT_KINDS)[number];

export const REPORT_REASONS = ["spam", "harassment", "hate", "illegal", "sexual", "impersonation", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** What a reviewer says was done, when closing a report as resolved. Recorded, not done: the action itself goes through its own route. */
export const RESOLVE_ACTIONS = ["none", "message_deleted", "member_kicked", "member_banned", "account_suspended", "community_changed", "other"] as const;
export type ResolveAction = (typeof RESOLVE_ACTIONS)[number];

export const MAX_DETAILS_LENGTH = 500;
export const MAX_NOTE_LENGTH = 500;
export const MAX_MESSAGE_TEXT = 2000;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_URL = 500;
export const MAX_PROFILE_TEXT = 500;
export const MAX_LABEL = 200;

/** One person's limits: this many new reports an hour, and this many open at once. */
export const MAX_REPORTS_PER_HOUR = 10;
export const MAX_OPEN_REPORTS = 30;
/** What one other server may send this one in an hour, however many people it says it has (docs/content-reports.md, relaying). */
export const MAX_REPORTS_PER_DOMAIN_PER_HOUR = 100;

/**
 * How long a person waits for the community's home server to take a report, and how many times it is asked. Once and for 5 seconds, not
 * the proxy's 8 seconds three times (nearly half a minute before "try again"): the request is not repeated, so a home server that is up but
 * slow is not sent the same report three times. If it did take the report after all, the person's next try gets `409 already_reported` from it,
 * which is kept (docs/content-reports.md, relaying).
 */
export const REPORT_RELAY_TIMEOUT_MS = 5000;
export const REPORT_RELAY_ATTEMPTS = 1;

export const DEFAULT_REPORT_RETENTION_DAYS = 180;
export const MAX_REPORT_RETENTION_DAYS = 3650;

/** Parses `REPORT_RETENTION_DAYS`: unset is 180; otherwise a whole number of days from 0 (keep for ever) to 3650, or it throws. */
export function parseReportRetentionDays(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_REPORT_RETENTION_DAYS;
  if (!/^\d{1,4}$/u.test(value) || Number(value) > MAX_REPORT_RETENTION_DAYS) {
    throw new Error(
      `REPORT_RETENTION_DAYS is "${raw}", which is not a whole number of days from 0 to ${MAX_REPORT_RETENTION_DAYS}. It is how long a content report, with the snapshot of what was reported, is kept (default ${DEFAULT_REPORT_RETENTION_DAYS}, 0 keeps them for ever); a value that could be a typo is refused rather than guessed.`
    );
  }
  return Number(value);
}

export const isReportKind = (value: unknown): value is ReportKindName => typeof value === "string" && (REPORT_KINDS as readonly string[]).includes(value);
export const isReportReason = (value: unknown): value is ReportReason => typeof value === "string" && (REPORT_REASONS as readonly string[]).includes(value);
export const isResolveAction = (value: unknown): value is ResolveAction => typeof value === "string" && (RESOLVE_ACTIONS as readonly string[]).includes(value);

// A control, format or separator character (a direction override, a zero-width character) can hide or reorder text a reviewer reads.
// Line breaks and tabs are kept in running text, where they are part of what was written.
const STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const STRIP_KEEPING_BREAKS = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const cut = (text: string, max: number) => (text.length <= max ? text : `${[...text].slice(0, max - 1).join("")}…`);

/** One short clean line (a name, a label). */
export function cleanLine(text: string | null | undefined, max = MAX_LABEL): string | null {
  if (text === null || text === undefined) return null;
  const line = cut(text.replace(STRIP, " ").replace(/\s+/gu, " ").trim(), max);
  return line === "" ? null : line;
}

/** Running text (a message, a bio, the reporter's words): cut to `max` characters, with only the characters that could mislead taken out. */
export function cleanText(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const clean = cut(text.replace(STRIP_KEEPING_BREAKS, "").trim(), max);
  return clean === "" ? null : clean;
}

/** `message:<id>`: what makes "the same thing" for the rule that one person reports it once. */
export const targetKeyOf = (kind: ReportKindName, id: string) => `${kind}:${id}`;

export interface MessageSnapshotInput {
  content: string | null;
  attachmentUrls: string[];
  createdAt: Date;
  editedAt: Date | null;
  /** Where it was said: a channel of a community, or a direct or group conversation. */
  where: { community: string; channel: string } | { conversation: "direct" | "group" };
  sender: { identity: string; displayName: string };
}

export function messageSnapshot(input: MessageSnapshotInput) {
  return {
    type: "message" as const,
    text: cleanText(input.content, MAX_MESSAGE_TEXT),
    attachments: input.attachmentUrls.slice(0, MAX_ATTACHMENTS).map((url) => cut(url, MAX_ATTACHMENT_URL)),
    attachmentCount: input.attachmentUrls.length,
    sentAt: input.createdAt.toISOString(),
    editedAt: input.editedAt ? input.editedAt.toISOString() : null,
    where:
      "conversation" in input.where
        ? { conversation: input.where.conversation }
        : { community: cleanLine(input.where.community), channel: cleanLine(input.where.channel) },
    sender: { identity: cleanLine(input.sender.identity), displayName: cleanLine(input.sender.displayName) },
  };
}

export interface UserSnapshotInput {
  identity: string;
  displayName: string;
  bio: string | null;
  pronouns: string | null;
  customStatus: string | null;
}

export function userSnapshot(input: UserSnapshotInput) {
  return {
    type: "user" as const,
    identity: cleanLine(input.identity),
    displayName: cleanLine(input.displayName),
    bio: cleanText(input.bio, MAX_PROFILE_TEXT),
    pronouns: cleanLine(input.pronouns, 64),
    customStatus: cleanLine(input.customStatus, 128),
  };
}

export interface CommunitySnapshotInput {
  name: string;
  description: string | null;
  iconText: string | null;
  owner: { identity: string; displayName: string };
}

export function communitySnapshot(input: CommunitySnapshotInput) {
  return {
    type: "community" as const,
    name: cleanLine(input.name),
    description: cleanText(input.description, MAX_PROFILE_TEXT),
    iconText: cleanLine(input.iconText, 16),
    owner: { identity: cleanLine(input.owner.identity), displayName: cleanLine(input.owner.displayName) },
  };
}

/** What a snapshot becomes when the person it is about has their account erased: the report stays, what they wrote does not. */
export const ERASED_SNAPSHOT = { type: "erased" as const };
export type Snapshot = ReturnType<typeof messageSnapshot> | ReturnType<typeof userSnapshot> | ReturnType<typeof communitySnapshot> | typeof ERASED_SNAPSHOT;
