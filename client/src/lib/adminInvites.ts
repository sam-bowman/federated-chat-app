import type { AdminRegistrationInvite } from "../api";

// What the admin page's Invites tab needs that is not a component: the limits the server accepts, how an invite is described in a line, and
// the link a person can follow to the register screen with the code filled in.

/** What the server accepts (lib/registrationInvites.ts there; a test compares the two so they cannot drift). */
export const INVITE_LIMITS = { maxUses: 10_000, maxDays: 3650, maxCount: 50, maxNote: 100, defaultUses: 1, defaultDays: 7 } as const;

export const INVITE_STATUS_WORDS: Record<AdminRegistrationInvite["status"], string> = { active: "Active", revoked: "Revoked", expired: "Expired", used_up: "Used up" };

const day = (iso: string) => new Date(iso).toLocaleDateString();

/** How much a code has been used and when it ends, in one line. */
export function inviteSummary(invite: Pick<AdminRegistrationInvite, "uses" | "maxUses" | "expiresAt" | "status">): string {
  const used = invite.maxUses === null ? `${invite.uses} used` : `${invite.uses} of ${invite.maxUses} used`;
  const ends = invite.expiresAt === null ? "never ends" : `${invite.status === "expired" ? "ended" : "ends"} ${day(invite.expiresAt)}`;
  return `${used} · ${ends}`;
}

/** The link someone can follow to get to the register screen with the code filled in (`/register?invite=`, which the register screen reads). */
export const inviteLink = (code: string, origin: string = window.location.origin) => `${origin}/register?invite=${encodeURIComponent(code)}`;

/** A whole number inside the range, from what was typed, or undefined. */
export function whole(text: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : undefined;
}
