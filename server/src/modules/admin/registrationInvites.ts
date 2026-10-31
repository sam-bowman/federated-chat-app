import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import type { InviteStatus } from "../../lib/invites.js";
import { generateInviteCode, registrationInviteStatus, type CreateOptions } from "../../lib/registrationInvites.js";
import { recordAudit } from "../audit/service.js";
import { CLI_CONTEXT, type AdminContext } from "./service.js";

// The codes an invite-only server asks for (#206, registration invites). Plain functions over the database, so the command
// (cli/registrationInvites.ts) and the admin page share one set of rules, and both write the audit entry themselves.
//
// A code is a credential: whoever has it can make an account. The admin sees the codes (they have to hand them out, as the command's
// `list` shows them), but they never go into the audit log: an entry names an invite by its id and the last four characters of the code.

const DAY_MS = 86_400_000;

/** How many invites a list answers with. Operators make dozens, not thousands; the newest come first. */
export const MAX_INVITE_LIST = 200;

export interface RegistrationInviteSummary {
  id: string;
  code: string;
  /** The admin's reminder of who it is for. Never shown to the person using the code. */
  note: string | null;
  status: InviteStatus;
  uses: number;
  /** Null: no limit. */
  maxUses: number | null;
  /** Null: never expires. */
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  /** The usernames of the accounts made with it (an erased account is not named). */
  joined: string[];
}

const SELECT = {
  id: true,
  code: true,
  note: true,
  uses: true,
  maxUses: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  // An erased account is not named: erasing it unlinks it from the invite (users/deletion.ts), so it is no longer in this list.
  users: { select: { username: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.RegistrationInviteSelect;

type Row = Prisma.RegistrationInviteGetPayload<{ select: typeof SELECT }>;

// Field by field, never by spreading the row, so a column added later cannot reach the page by accident.
function summarize(row: Row, now: Date = new Date()): RegistrationInviteSummary {
  return {
    id: row.id,
    code: row.code,
    note: row.note,
    status: registrationInviteStatus(row, now),
    uses: row.uses,
    maxUses: row.maxUses,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    joined: row.users.map((u) => u.username),
  };
}

const target = (invite: { id: string; code: string }) => ({ type: "registration_invite", id: invite.id, label: `…${invite.code.slice(-4)}` });

/** `count` new codes with the same limits. Each is recorded in the audit log on its own, so a revoke can be matched to it. */
export async function createRegistrationInvites(options: CreateOptions, ctx: AdminContext = CLI_CONTEXT, db: PrismaClient = prisma): Promise<RegistrationInviteSummary[]> {
  const { maxUses, expiresInDays, note, count } = options;
  const expiresAt = expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY_MS);
  const made: RegistrationInviteSummary[] = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; ; attempt++) {
      try {
        const row = await db.registrationInvite.create({ data: { code: generateInviteCode(), note, maxUses, expiresAt }, select: SELECT });
        made.push(summarize(row));
        break;
      } catch (err) {
        // A code already taken (astronomically unlikely): try another.
        if (attempt < 5 && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }
  }
  for (const invite of made) {
    await recordAudit({
      source: ctx.source,
      action: "registration_invite.create",
      actor: ctx.actor,
      target: target(invite),
      details: { maxUses, days: expiresInDays, hasNote: note !== null },
    });
  }
  return made;
}

/** The newest invites first: the ones that can still be used, or with `all` also the revoked, expired and used up. `total` counts what matched. */
export async function listRegistrationInvites(options: { all?: boolean } = {}, db: PrismaClient = prisma): Promise<{ invites: RegistrationInviteSummary[]; total: number }> {
  const now = new Date();
  // Whether a code is "used up" compares two columns, which a database filter cannot say, so the filter is applied here: the table is small.
  const rows = await db.registrationInvite.findMany({ select: SELECT, orderBy: { createdAt: "desc" } });
  const all = rows.map((row) => summarize(row, now));
  const shown = options.all ? all : all.filter((invite) => invite.status === "active");
  return { invites: shown.slice(0, MAX_INVITE_LIST), total: shown.length };
}

export type RevokeResult = { ok: true; invite: RegistrationInviteSummary; changed: boolean } | { ok: false; error: "not_found" };

/** Stops a code from being used. People who already made an account with it keep theirs. A code that was already revoked is not recorded again. */
export async function revokeRegistrationInvite(which: { id: string } | { code: string }, ctx: AdminContext = CLI_CONTEXT, db: PrismaClient = prisma): Promise<RevokeResult> {
  const found = await db.registrationInvite.findUnique({ where: which, select: { id: true, code: true, revokedAt: true } });
  if (!found) return { ok: false, error: "not_found" };
  if (!found.revokedAt) {
    // Conditional, so two people revoking at once record it once.
    const { count } = await db.registrationInvite.updateMany({ where: { id: found.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (count === 1) {
      await recordAudit({ source: ctx.source, action: "registration_invite.revoke", actor: ctx.actor, target: target(found) });
      return { ok: true, invite: summarize(await db.registrationInvite.findUniqueOrThrow({ where: { id: found.id }, select: SELECT })), changed: true };
    }
  }
  return { ok: true, invite: summarize(await db.registrationInvite.findUniqueOrThrow({ where: { id: found.id }, select: SELECT })), changed: false };
}
