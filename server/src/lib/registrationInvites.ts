import { generateInviteCode, inviteStatus, normalizeInviteCode, type InviteState, type InviteStatus } from "./invites.js";

/**
 * Registration invites: a code that lets one person (or several, if the operator allows) make an account on a server
 * that is invite-only. The operator makes them with the command line (never over the API), so there is no "who may make
 * one" question here, only what a code is and how it ends. The pure part: the database work is in
 * modules/auth/registrationInviteService.ts and the command is in cli/registrationInvites.ts.
 *
 * The code format, alphabet and how a status is worked out are the community invites' own (lib/invites.ts), so the two
 * kinds cannot drift: a code is 10 characters with no look-alikes, matched without regard to case.
 */

export { generateInviteCode, normalizeInviteCode };

/** What `create` makes when the operator does not say: one account, for a week. */
export const DEFAULT_MAX_USES = 1;
export const DEFAULT_EXPIRY_DAYS = 7;
export const MAX_REGISTRATION_USES = 10_000;
export const MAX_EXPIRY_DAYS = 3650;
export const MAX_NOTE_LENGTH = 100;
export const MAX_CODES_PER_CREATE = 50;

export type RegistrationInviteFailure =
  | "registration_invite_required"
  | "registration_invite_invalid"
  | "registration_invite_revoked"
  | "registration_invite_expired"
  | "registration_invite_used_up";

/** The answer for a code that cannot be used, by what is wrong with it (revoked beats expired beats used up). */
export function registrationInviteFailure(status: Exclude<InviteStatus, "active">): RegistrationInviteFailure {
  return status === "revoked"
    ? "registration_invite_revoked"
    : status === "expired"
      ? "registration_invite_expired"
      : "registration_invite_used_up";
}

/** What a code is right now, the same words as a community invite's. */
export function registrationInviteStatus(invite: InviteState, now: Date = new Date()): InviteStatus {
  return inviteStatus(invite, now);
}

export interface CreateOptions {
  maxUses: number | null;
  expiresInDays: number | null;
  note: string | null;
  count: number;
}

/** The result of reading the command line: the options, or one sentence saying what is wrong. */
export type ParsedCreate = { ok: true; options: CreateOptions } | { ok: false; message: string };

function whole(name: string, raw: string, min: number, max: number): number | string {
  if (!/^\d+$/.test(raw)) return `${name} must be a whole number, not "${raw}".`;
  const n = Number(raw);
  if (n < min || n > max) return `${name} must be between ${min} and ${max}.`;
  return n;
}

/**
 * Reads `create`'s options: `--uses <n|unlimited>`, `--days <n|never>`, `--note <text>` and `--count <n>`. Anything not
 * recognised is refused, so a misspelt `--day 1` cannot quietly leave the default week in place.
 */
export function parseCreateArgs(args: string[]): ParsedCreate {
  const options: CreateOptions = { maxUses: DEFAULT_MAX_USES, expiresInDays: DEFAULT_EXPIRY_DAYS, note: null, count: 1 };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (!["--uses", "--days", "--note", "--count"].includes(flag)) return { ok: false, message: `Unknown option "${flag}".` };
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `${flag} needs a value.` };
    i++;
    if (flag === "--uses") {
      if (value === "unlimited") options.maxUses = null;
      else {
        const n = whole("--uses", value, 1, MAX_REGISTRATION_USES);
        if (typeof n === "string") return { ok: false, message: n };
        options.maxUses = n;
      }
    } else if (flag === "--days") {
      if (value === "never") options.expiresInDays = null;
      else {
        const n = whole("--days", value, 1, MAX_EXPIRY_DAYS);
        if (typeof n === "string") return { ok: false, message: n };
        options.expiresInDays = n;
      }
    } else if (flag === "--count") {
      const n = whole("--count", value, 1, MAX_CODES_PER_CREATE);
      if (typeof n === "string") return { ok: false, message: n };
      options.count = n;
    } else {
      const note = value.trim();
      if (note.length > MAX_NOTE_LENGTH) return { ok: false, message: `--note can be at most ${MAX_NOTE_LENGTH} characters.` };
      options.note = note === "" ? null : note;
    }
  }
  return { ok: true, options };
}
