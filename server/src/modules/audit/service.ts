import { prisma } from "../../db.js";
import { identityFor } from "../../lib/ids.js";
import type { AuditAction, AuditSource } from "../../lib/auditActions.js";
import { sanitizeDetails, sanitizeLabel, type AuditDetails } from "../../lib/auditDetails.js";

// The audit log (#59): who did what, for the actions that change something other people depend on. Written by the routes that do those
// things (a community's moderation), by the operator's command and the admin page (modules/admin/service.ts), and by the worker that erases
// accounts; read by the admin page (everything) and a community's managers (their own community). It is append-only: nothing here edits or
// deletes an entry except retention and the erasure of a person's name, and an entry holds ids and short labels, never what anyone wrote.

/** Who did it. A person is recorded by id and as they were called at the time; the command line and the system have no account. */
export type AuditActor =
  | { kind: "user"; user: { protocolId: string; username: string; homeserverDomain: string } }
  | { kind: "operator" }
  | { kind: "system" };

export const OPERATOR: AuditActor = { kind: "operator" };
export const SYSTEM: AuditActor = { kind: "system" };

export interface AuditInput {
  source: AuditSource;
  action: AuditAction;
  actor: AuditActor;
  /** The community it happened in, if it was in one. */
  community?: { protocolId: string; name: string } | null;
  /** What it was done to. A label is as it was at the time (a name can change later, the entry should still read). */
  target?: { type: string; id: string; label?: string | null } | null;
  details?: Record<string, unknown>;
}

const ACTOR_LABELS = { operator: "the operator (command line)", system: "the server (automatic)" } as const;
/** What a person's name in the log becomes when their account is erased. */
export const ERASED_LABEL = "Deleted user";

function actorOf(actor: AuditActor): { actorUserId: string | null; actorLabel: string } {
  if (actor.kind === "operator") return { actorUserId: null, actorLabel: ACTOR_LABELS.operator };
  if (actor.kind === "system") return { actorUserId: null, actorLabel: ACTOR_LABELS.system };
  return { actorUserId: actor.user.protocolId, actorLabel: identityFor(actor.user.username, actor.user.homeserverDomain) };
}

/** Writes one entry. Never throws: an action that has already happened must not fail because its record could not be written, and the failure is said loudly instead. */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLogEntry.create({
      data: {
        source: input.source,
        action: input.action,
        ...actorOf(input.actor),
        communityId: input.community?.protocolId ?? null,
        communityLabel: sanitizeLabel(input.community?.name),
        targetType: input.target?.type ?? null,
        targetId: input.target?.id ?? null,
        targetLabel: sanitizeLabel(input.target?.label),
        details: (sanitizeDetails(input.details) as AuditDetails | null) ?? undefined,
      },
    });
  } catch (err) {
    console.error("[audit] could not record an entry:", err);
  }
}

/** The same for a person using the app, found by their database id (what a route has in `req.userId`). */
export async function recordUserAudit(userId: string, input: Omit<AuditInput, "actor" | "source"> & { source?: AuditSource }): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { protocolId: true, username: true, homeserverDomain: true } });
  if (!user) return;
  await recordAudit({ source: "api", ...input, actor: { kind: "user", user } });
}

export interface AuditFilter {
  /** Only entries older than this id (the `next` of the previous page). */
  before?: number;
  limit?: number;
  action?: string;
  source?: string;
  /** A community's protocolId. */
  communityId?: string;
  /** The protocolId of whoever did it. */
  actorUserId?: string;
  /** The id of what it was done to. */
  targetId?: string;
}

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

type Row = {
  id: number;
  createdAt: Date;
  source: string;
  action: string;
  actorUserId: string | null;
  actorLabel: string;
  communityId: string | null;
  communityLabel: string | null;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  details: unknown;
};

/** What the API says about an entry. Built field by field, so a column added to the table later is not sent until someone decides it should be. */
export function serializeAudit(row: Row) {
  return {
    id: row.id,
    at: row.createdAt,
    source: row.source,
    action: row.action,
    actor: { id: row.actorUserId, label: row.actorLabel },
    community: row.communityId ? { id: row.communityId, name: row.communityLabel } : null,
    target: row.targetType && row.targetId ? { type: row.targetType, id: row.targetId, label: row.targetLabel } : null,
    details: row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details : {},
  };
}

export type SerializedAudit = ReturnType<typeof serializeAudit>;

/** A page of entries, newest first. `next` is what to ask for to get the page after it, or null at the end. */
export async function listAudit(filter: AuditFilter = {}): Promise<{ entries: SerializedAudit[]; next: number | null }> {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DEFAULT_PAGE) || DEFAULT_PAGE, 1), MAX_PAGE);
  const rows = await prisma.auditLogEntry.findMany({
    where: {
      ...(filter.before !== undefined ? { id: { lt: filter.before } } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.communityId ? { communityId: filter.communityId } : {}),
      ...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
      ...(filter.targetId ? { targetId: filter.targetId } : {}),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return { entries: page.map(serializeAudit), next: rows.length > limit ? page[page.length - 1].id : null };
}

/**
 * Takes a person's name out of the log when their account is erased (#60): wherever they did something, and wherever something was done to
 * them. The entries stay (what was done is still true), but they no longer say who. The ids stay too, and mean nothing without the account.
 */
export async function eraseNameFromAudit(userProtocolId: string): Promise<void> {
  await prisma.auditLogEntry.updateMany({ where: { actorUserId: userProtocolId }, data: { actorLabel: ERASED_LABEL } });
  await prisma.auditLogEntry.updateMany({ where: { targetType: "user", targetId: userProtocolId }, data: { targetLabel: ERASED_LABEL } });
}

/** Deletes entries older than `days` days. 0 keeps everything. Returns how many went. */
export async function pruneAudit(days: number, now: Date = new Date()): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return (await prisma.auditLogEntry.deleteMany({ where: { createdAt: { lt: cutoff } } })).count;
}

/** Prunes shortly after start and then once a day. Returns the function that stops it. */
export function startAuditPruning(days: number, intervalMs = 24 * 60 * 60 * 1000): () => void {
  const run = () => {
    pruneAudit(days).catch((err) => console.error("[audit] could not prune the log:", err));
  };
  const first = setTimeout(run, 5 * 60 * 1000);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
