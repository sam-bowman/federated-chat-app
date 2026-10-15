import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Invites: a code that lets someone into a community, can end (an expiry, a use limit, revocation) and is checked by
 * the community's home server whenever someone joins, whichever server they come from. This file is the pure part
 * (the rules and the formats); the database work is in modules/communities/inviteService.ts.
 *
 * A code is not the community's id: the id is permanent and public (anyone with it can join while the community is
 * "open"), a code is what you hand out when you want to be able to take it back.
 */

// Crockford's base32: digits and upper-case letters without I, L, O and U, so a code cannot be misread (no 0/O, 1/I/L)
// and can be read out or typed. It is exactly 32 characters, so one random byte masked to 5 bits picks one with no bias.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INVITE_CODE_LENGTH = 10;

// What a code may look like when it arrives (typed, pasted, or inside a card from another server). Matching ignores
// case; see normalizeInviteCode.
export const INVITE_CODE_PATTERN = /^[0-9A-Za-z]{6,32}$/;

/** A fresh random code: 10 characters of 5 bits each (50 bits), from the system's secure random source. */
export function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte & 31];
  return code;
}

/** The form a code is stored and looked up in, so typing it in lower case still works. */
export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}

/** The ways an invite can be offered to expire, in seconds. `null` is "never". */
export const INVITE_EXPIRY_CHOICES_SECONDS = [3600, 86_400, 604_800] as const;
/** What an invite sent to a friend as a card lasts. */
export const CARD_INVITE_EXPIRY_SECONDS = 604_800;
export const MAX_INVITE_USES = 1000;

export const createInviteSchema = z.object({
  expiresInSeconds: z
    .number()
    .refine((n) => (INVITE_EXPIRY_CHOICES_SECONDS as readonly number[]).includes(n), "not one of the offered lifetimes")
    .nullable()
    .optional(),
  maxUses: z.number().int().min(1).max(MAX_INVITE_USES).nullable().optional(),
});

export type InviteStatus = "active" | "revoked" | "expired" | "used_up";

export interface InviteState {
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
  revokedAt: Date | null;
}

/** What an invite is right now. Revoked wins over expired wins over used up, so the reason given is the strongest. */
export function inviteStatus(invite: InviteState, now: Date = new Date()): InviteStatus {
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) return "expired";
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) return "used_up";
  return "active";
}

/** The error a join answers with for an invite that cannot be used. */
export function inviteFailureCode(status: Exclude<InviteStatus, "active">): "invite_revoked" | "invite_expired" | "invite_used_up" {
  return status === "revoked" ? "invite_revoked" : status === "expired" ? "invite_expired" : "invite_used_up";
}

/**
 * Splits what a person gives to join: "<communityId>", "<communityId>:<domain>" or either followed by "#<code>". The
 * community id is case-sensitive (a ULID), the domain is not, and the code is case-sensitive too.
 */
export function parseJoinReference(
  input: string,
  defaultDomain: string
): { protocolId: string; domain: string; code: string | null } | null {
  const match = /^@?([0-9A-Za-z]+)(?::([^#\s]+))?(?:#([0-9A-Za-z]+))?$/.exec(input.trim());
  if (!match) return null;
  const [, protocolId, domain, code] = match;
  if (code !== undefined && !INVITE_CODE_PATTERN.test(code)) return null;
  return { protocolId, domain: (domain ?? defaultDomain).toLowerCase(), code: code ?? null };
}

/** The text of a full invite code: the community, where it lives, and the invite itself. */
export function inviteJoinReference(community: { protocolId: string; homeserverDomain: string }, code: string): string {
  return `${community.protocolId}:${community.homeserverDomain}#${code}`;
}
