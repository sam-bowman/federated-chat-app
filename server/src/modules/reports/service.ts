import { Prisma, type Report, type ReportStatus } from "@prisma/client";
import { prisma } from "../../db.js";
import { identityFor, newProtocolId } from "../../lib/ids.js";
import {
  ERASED_SNAPSHOT,
  MAX_OPEN_REPORTS,
  MAX_REPORTS_PER_HOUR,
  cleanLine,
  cleanText,
  communitySnapshot,
  MAX_DETAILS_LENGTH,
  MAX_NOTE_LENGTH,
  messageSnapshot,
  targetKeyOf,
  userSnapshot,
  type ReportKindName,
  type ReportReason,
  type ResolveAction,
} from "../../lib/reports.js";
import type { AuditSource } from "../../lib/auditActions.js";
import { ERASED_LABEL, recordAudit } from "../audit/service.js";

// Content reports (#58, docs/content-reports.md). A person reports a message, a person or a community; whoever it reaches (a community's
// reviewers, or the server's admins) reads a snapshot taken at the time and closes it. Everything here is written so that the reported person
// is never told, and so that a report is no more than it has to be: ids, labels as they were, and the limited snapshot of lib/reports.ts.

type Reporter = { id: string; protocolId: string; username: string; homeserverDomain: string };
/** A person reviewing: found by the route, found again here only for what the audit log and the report need. */
export type Reviewer = { protocolId: string; username: string; homeserverDomain: string };

const identityOf = (user: { username: string; homeserverDomain: string }) => identityFor(user.username, user.homeserverDomain);

// ---- making a report -------------------------------------------------------------------------------------------------------------

export type CreateRefusal = "not_found" | "remote_community" | "cannot_report_self" | "already_reported" | "too_many_reports";
export type CreateResult = { ok: true } | { ok: false; error: CreateRefusal };
const refuse = (error: CreateRefusal): CreateResult => ({ ok: false, error });

export interface CreateInput {
  kind: ReportKindName;
  id: string;
  reason: ReportReason;
  details?: string | null;
}

/** What the thing reported turns into: where it goes and what is kept. */
interface Found {
  scope: "COMMUNITY" | "SERVER";
  communityId: string | null;
  targetId: string;
  targetUserId: string | null;
  targetLabel: string | null;
  snapshot: Prisma.InputJsonObject;
}

async function findMessage(reporter: Reporter, protocolId: string): Promise<Found | CreateResult> {
  const message = await prisma.message.findUnique({
    where: { protocolId },
    include: {
      sender: true,
      attachments: { select: { url: true } },
      channel: { include: { community: true } },
      conversation: { select: { id: true, type: true } },
    },
  });
  if (!message || message.deletedAt) return refuse("not_found");

  let where: Parameters<typeof messageSnapshot>[0]["where"];
  let scope: Found["scope"];
  let communityId: string | null = null;
  if (message.channel) {
    const community = message.channel.community;
    const member = await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: reporter.id } }, select: { id: true } });
    if (!member && community.ownerId !== reporter.id) return refuse("not_found");
    // This server only has a copy of a community hosted elsewhere: nobody here can act on it, and the people who can are not told.
    if (community.isRemote) return refuse("remote_community");
    where = { community: community.name, channel: message.channel.name };
    scope = "COMMUNITY";
    communityId = community.id;
  } else if (message.conversation) {
    const member = await prisma.conversationMember.findFirst({ where: { conversationId: message.conversation.id, userId: reporter.id }, select: { id: true } });
    if (!member) return refuse("not_found");
    where = { conversation: message.conversation.type === "DM" ? "direct" : "group" };
    scope = "SERVER";
  } else {
    return refuse("not_found");
  }
  if (message.senderId === reporter.id) return refuse("cannot_report_self");

  const sender = { identity: identityOf(message.sender), displayName: message.sender.displayName };
  return {
    scope,
    communityId,
    targetId: message.protocolId,
    targetUserId: message.sender.protocolId,
    targetLabel: cleanLine(sender.identity),
    snapshot: messageSnapshot({
      content: message.content,
      attachmentUrls: message.attachments.map((a) => a.url),
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      where,
      sender,
    }),
  };
}

async function findUser(reporter: Reporter, protocolId: string): Promise<Found | CreateResult> {
  const target = await prisma.user.findUnique({ where: { protocolId } });
  if (!target || target.deletedAt) return refuse("not_found");
  // A person who has blocked you cannot be looked at by you, so they cannot be reported by you either.
  const blocked = await prisma.block.findFirst({ where: { blockerId: target.id, blockedId: reporter.id }, select: { id: true } });
  if (blocked) return refuse("not_found");
  if (target.id === reporter.id) return refuse("cannot_report_self");
  const identity = identityOf(target);
  return {
    scope: "SERVER",
    communityId: null,
    targetId: target.protocolId,
    targetUserId: target.protocolId,
    targetLabel: cleanLine(identity),
    snapshot: userSnapshot({ identity, displayName: target.displayName, bio: target.bio, pronouns: target.pronouns, customStatus: target.customStatus }),
  };
}

async function findCommunity(reporter: Reporter, protocolId: string): Promise<Found | CreateResult> {
  const community = await prisma.community.findUnique({ where: { protocolId }, include: { owner: true } });
  if (!community) return refuse("not_found");
  const member = await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: reporter.id } }, select: { id: true } });
  if (!member && community.ownerId !== reporter.id) return refuse("not_found");
  if (community.isRemote) return refuse("remote_community");
  if (community.ownerId === reporter.id) return refuse("cannot_report_self");
  return {
    scope: "SERVER",
    communityId: community.id,
    targetId: community.protocolId,
    targetUserId: null,
    targetLabel: cleanLine(community.name),
    snapshot: communitySnapshot({
      name: community.name,
      description: community.description,
      iconText: community.iconText,
      owner: { identity: identityOf(community.owner), displayName: community.owner.displayName },
    }),
  };
}

const isRefusal = (found: Found | CreateResult): found is CreateResult => "ok" in found;

/**
 * Records one report. Nothing is said to the person reported, and nothing is written to the audit log (a community's managers can read it,
 * and they need not be reviewers). The limits are counted in the database, so they hold across replicas.
 */
export async function createReport(reporter: Reporter, input: CreateInput): Promise<CreateResult> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [lastHour, open] = await Promise.all([
    prisma.report.count({ where: { reporterId: reporter.protocolId, createdAt: { gte: hourAgo } } }),
    prisma.report.count({ where: { reporterId: reporter.protocolId, status: "OPEN" } }),
  ]);
  if (lastHour >= MAX_REPORTS_PER_HOUR || open >= MAX_OPEN_REPORTS) return refuse("too_many_reports");

  const found = await (input.kind === "message" ? findMessage : input.kind === "user" ? findUser : findCommunity)(reporter, input.id);
  if (isRefusal(found)) return found;

  try {
    await prisma.report.create({
      data: {
        protocolId: newProtocolId(),
        kind: input.kind === "message" ? "MESSAGE" : input.kind === "user" ? "USER" : "COMMUNITY",
        scope: found.scope,
        reason: input.reason,
        details: cleanText(input.details, MAX_DETAILS_LENGTH),
        reporterId: reporter.protocolId,
        reporterLabel: identityOf(reporter),
        targetKey: targetKeyOf(input.kind, found.targetId),
        targetId: found.targetId,
        targetUserId: found.targetUserId,
        targetLabel: found.targetLabel,
        communityId: found.communityId,
        snapshot: found.snapshot,
      },
    });
  } catch (err) {
    // The unique key (reporter, target): the same person reporting the same thing twice, including two requests at once.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return refuse("already_reported");
    throw err;
  }
  return { ok: true };
}

// ---- reading the queue ---------------------------------------------------------------------------------------------------------

/** Whose queue: one community's (reports about messages in it), or the server's (everything that reaches this server). */
export type QueueScope = { type: "community"; communityId: string } | { type: "admin" };

export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 100;

export interface ReportFilter {
  status?: "open" | "resolved" | "dismissed";
  /** Admins only: narrow to what goes to a community's moderators, or to the admins alone. */
  scope?: "community" | "server";
  /** Only reports older than this (the `next` of the previous page). */
  before?: number;
  limit?: number;
}

const STATUS: Record<NonNullable<ReportFilter["status"]>, ReportStatus> = { open: "OPEN", resolved: "RESOLVED", dismissed: "DISMISSED" };

/**
 * What a reviewer may see. A community's queue holds only the reports made about messages in it: never the ones about the community itself
 * (its moderators cannot judge their own community). Nobody sees a report about themself: a reviewer who is the person reported would
 * otherwise read who reported them.
 */
function visibleTo(scope: QueueScope, viewer: Reviewer): Prisma.ReportWhereInput {
  const notAboutViewer: Prisma.ReportWhereInput = { OR: [{ targetUserId: null }, { targetUserId: { not: viewer.protocolId } }] };
  const within: Prisma.ReportWhereInput = scope.type === "community" ? { scope: "COMMUNITY", communityId: scope.communityId } : {};
  return { AND: [within, notAboutViewer] };
}

interface History {
  total: number;
  dismissed: number;
}

export function serializeReport(report: Report, history: History | null) {
  return {
    id: report.protocolId,
    createdAt: report.createdAt.toISOString(),
    kind: report.kind.toLowerCase(),
    scope: report.scope.toLowerCase(),
    status: report.status.toLowerCase(),
    reason: report.reason,
    details: report.details,
    reporter: { id: report.reporterId, label: report.reporterId === null ? ERASED_LABEL : report.reporterLabel, history },
    target: { id: report.targetId, userId: report.targetUserId, label: report.targetLabel },
    communityId: null as string | null,
    snapshot: report.snapshot,
    resolution:
      report.status === "OPEN"
        ? null
        : { at: report.resolvedAt ? report.resolvedAt.toISOString() : null, by: report.resolvedByLabel, action: report.action, note: report.note },
  };
}
export type SerializedReport = ReturnType<typeof serializeReport>;

/** How many reports each of these people has made in this queue, and how many of them were dismissed: a pattern of false reports shows. */
async function historyOf(scope: QueueScope, reporterIds: string[]): Promise<Map<string, History>> {
  const result = new Map<string, History>();
  if (reporterIds.length === 0) return result;
  const rows = await prisma.report.groupBy({
    by: ["reporterId", "status"],
    where: { reporterId: { in: reporterIds }, ...(scope.type === "community" ? { scope: "COMMUNITY", communityId: scope.communityId } : {}) },
    _count: { _all: true },
  });
  for (const row of rows) {
    if (row.reporterId === null) continue;
    const entry = result.get(row.reporterId) ?? { total: 0, dismissed: 0 };
    entry.total += row._count._all;
    if (row.status === "DISMISSED") entry.dismissed += row._count._all;
    result.set(row.reporterId, entry);
  }
  return result;
}

async function withCommunityIds(reports: Report[]): Promise<Map<string, string>> {
  const ids = [...new Set(reports.map((r) => r.communityId).filter((id): id is string => id !== null))];
  const rows = ids.length === 0 ? [] : await prisma.community.findMany({ where: { id: { in: ids } }, select: { id: true, protocolId: true } });
  return new Map(rows.map((c) => [c.id, c.protocolId]));
}

async function serializeAll(scope: QueueScope, reports: Report[]) {
  const [history, communities] = await Promise.all([
    historyOf(scope, [...new Set(reports.map((r) => r.reporterId).filter((id): id is string => id !== null))]),
    withCommunityIds(reports),
  ]);
  return reports.map((r) => ({
    ...serializeReport(r, r.reporterId === null ? null : (history.get(r.reporterId) ?? { total: 0, dismissed: 0 })),
    communityId: r.communityId ? (communities.get(r.communityId) ?? null) : null,
  }));
}

export async function listReports(scope: QueueScope, viewer: Reviewer, filter: ReportFilter = {}): Promise<{ reports: SerializedReport[]; next: number | null; open: number }> {
  const limit = Math.min(filter.limit ?? DEFAULT_PAGE, MAX_PAGE);
  const visible = visibleTo(scope, viewer);
  const where: Prisma.ReportWhereInput = {
    AND: [
      visible,
      filter.status ? { status: STATUS[filter.status] } : {},
      scope.type === "admin" && filter.scope ? { scope: filter.scope === "community" ? "COMMUNITY" : "SERVER" } : {},
      filter.before !== undefined ? { id: { lt: filter.before } } : {},
    ],
  };
  const [rows, open] = await Promise.all([
    prisma.report.findMany({ where, orderBy: { id: "desc" }, take: limit + 1 }),
    prisma.report.count({ where: { AND: [visible, { status: "OPEN" }] } }),
  ]);
  const page = rows.slice(0, limit);
  return { reports: await serializeAll(scope, page), next: rows.length > limit ? page[page.length - 1].id : null, open };
}

async function findVisible(scope: QueueScope, viewer: Reviewer, protocolId: string): Promise<Report | null> {
  return prisma.report.findFirst({ where: { AND: [visibleTo(scope, viewer), { protocolId }] } });
}

export async function getReport(scope: QueueScope, viewer: Reviewer, protocolId: string): Promise<SerializedReport | null> {
  const report = await findVisible(scope, viewer, protocolId);
  return report ? (await serializeAll(scope, [report]))[0] : null;
}

// ---- closing and reopening -----------------------------------------------------------------------------------------------------

export interface ReviewerContext {
  reviewer: Reviewer;
  source: Extract<AuditSource, "api" | "admin">;
}

export type ReviewResult = { ok: true; report: SerializedReport } | { ok: false; error: "not_found" | "not_open" | "not_closed" };

/** Resolving says what was done (lib/reports.ts RESOLVE_ACTIONS); dismissing has nothing to say about that. */
export type CloseInput = { status: "RESOLVED"; action: ResolveAction; note?: string | null } | { status: "DISMISSED"; note?: string | null };

/** Where the entry is written: the community's log only for what went to its moderators; the log of a community that was itself reported must not learn of it. */
async function audit(ctx: ReviewerContext, report: Report, action: "report.resolve" | "report.dismiss" | "report.reopen", details: Record<string, unknown>) {
  const community = report.scope === "COMMUNITY" && report.communityId ? await prisma.community.findUnique({ where: { id: report.communityId }, select: { protocolId: true, name: true } }) : null;
  await recordAudit({
    source: ctx.source,
    action,
    actor: { kind: "user", user: ctx.reviewer },
    community,
    // Ids and kind only: never the snapshot, the reporter's words or the note.
    target: { type: "report", id: report.protocolId, label: report.kind.toLowerCase() },
    details: { kind: report.kind.toLowerCase(), ...details },
  });
}

export async function closeReport(scope: QueueScope, ctx: ReviewerContext, protocolId: string, input: CloseInput): Promise<ReviewResult> {
  const report = await findVisible(scope, ctx.reviewer, protocolId);
  if (!report) return { ok: false, error: "not_found" };
  // Conditional on still being open, so two reviewers closing it at once cannot both win (and cannot both write an entry).
  const changed = await prisma.report.updateMany({
    where: { id: report.id, status: "OPEN" },
    data: {
      status: input.status,
      resolvedAt: new Date(),
      resolvedById: ctx.reviewer.protocolId,
      resolvedByLabel: identityOf(ctx.reviewer),
      action: input.status === "RESOLVED" ? input.action : null,
      note: cleanText(input.note, MAX_NOTE_LENGTH),
    },
  });
  if (changed.count === 0) return { ok: false, error: "not_open" };
  await audit(ctx, report, input.status === "RESOLVED" ? "report.resolve" : "report.dismiss", input.status === "RESOLVED" ? { action: input.action } : {});
  return { ok: true, report: (await getReport(scope, ctx.reviewer, protocolId))! };
}

export async function reopenReport(scope: QueueScope, ctx: ReviewerContext, protocolId: string): Promise<ReviewResult> {
  const report = await findVisible(scope, ctx.reviewer, protocolId);
  if (!report) return { ok: false, error: "not_found" };
  const changed = await prisma.report.updateMany({
    where: { id: report.id, status: { not: "OPEN" } },
    data: { status: "OPEN", resolvedAt: null, resolvedById: null, resolvedByLabel: null, action: null, note: null },
  });
  if (changed.count === 0) return { ok: false, error: "not_closed" };
  await audit(ctx, report, "report.reopen", {});
  return { ok: true, report: (await getReport(scope, ctx.reviewer, protocolId))! };
}

// ---- erasure and retention -----------------------------------------------------------------------------------------------------

/**
 * A person's account was erased (a local account, or a remote one their server told us is gone). Reports they made no longer say who made
 * them; what was reported about them, which is what they wrote, is replaced by a marker. The reports themselves stay: a moderator can still
 * see that there was one, and why.
 */
export async function eraseReportsOf(userProtocolId: string): Promise<void> {
  await prisma.report.updateMany({ where: { reporterId: userProtocolId }, data: { reporterId: null, reporterLabel: ERASED_LABEL } });
  await prisma.report.updateMany({ where: { targetUserId: userProtocolId }, data: { snapshot: ERASED_SNAPSHOT, targetLabel: ERASED_LABEL } });
  await prisma.report.updateMany({ where: { resolvedById: userProtocolId }, data: { resolvedByLabel: ERASED_LABEL } });
}

/** Deletes reports older than `days` days, whatever their state. 0 keeps everything. Returns how many went. */
export async function pruneReports(days: number, now: Date = new Date()): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return (await prisma.report.deleteMany({ where: { createdAt: { lt: cutoff } } })).count;
}

/** Prunes shortly after start and then once a day. Returns the function that stops it. */
export function startReportPruning(days: number, intervalMs = 24 * 60 * 60 * 1000): () => void {
  const run = () => {
    pruneReports(days).catch((err) => console.error("[reports] could not prune the reports:", err));
  };
  const first = setTimeout(run, 6 * 60 * 1000);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
