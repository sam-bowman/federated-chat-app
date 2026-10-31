import { Prisma, type Report, type ReportStatus } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { identityFor, newProtocolId } from "../../lib/ids.js";
import {
  ERASED_SNAPSHOT,
  MAX_OPEN_REPORTS,
  MAX_REPORTS_PER_DOMAIN_PER_HOUR,
  REPORT_RELAY_ATTEMPTS,
  REPORT_RELAY_TIMEOUT_MS,
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
import { FederationProxyError, proxyToHomeServer } from "../../lib/federation/proxy.js";

// Content reports (#58, docs/content-reports.md). A person reports a message, a person or a community; whoever it reaches (a community's
// reviewers, or the server's admins) reads a snapshot taken at the time and closes it. Everything here is written so that the reported person
// is never told, and so that a report is no more than it has to be: ids, labels as they were, and the limited snapshot of lib/reports.ts.

type Reporter = { id: string; protocolId: string; username: string; homeserverDomain: string; isRemote?: boolean };
/** A person reviewing: found by the route, found again here only for what the audit log and the report need. */
export type Reviewer = { protocolId: string; username: string; homeserverDomain: string };

const identityOf = (user: { username: string; homeserverDomain: string }) => identityFor(user.username, user.homeserverDomain);

// ---- making a report -------------------------------------------------------------------------------------------------------------

export type CreateRefusal =
  | "not_found"
  | "remote_community"
  | "cannot_report_self"
  | "already_reported"
  | "too_many_reports"
  // Only when the report is carried to another server (docs/content-reports.md): the reporter is no longer a member there, or that server
  // cannot be reached, or this one or that one will not talk to the other.
  | "not_a_member"
  | "federation_unreachable"
  | "federation_disabled"
  | "federation_domain_blocked";
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
  scope: "COMMUNITY" | "SERVER" | "REMOTE";
  /** For REMOTE: the community's home server and its id there. Nothing is kept here but that the report was made. */
  remote?: { domain: string; communityProtocolId: string };
  communityId: string | null;
  targetId: string;
  targetUserId: string | null;
  targetLabel: string | null;
  snapshot: Prisma.InputJsonObject;
}

/** `inCommunity` (a report that arrived from another server about this community) limits what can be found to that community's own. */
async function findMessage(reporter: Reporter, protocolId: string, inCommunity?: string): Promise<Found | CreateResult> {
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
    if (inCommunity !== undefined && community.protocolId !== inCommunity) return refuse("not_found");
    // This server only has a copy of a community hosted elsewhere: its home server is where the moderators are, so the report goes there
    // and only the fact that it was made is kept here. The person who wrote the message is not told.
    if (community.isRemote) {
      if (message.senderId === reporter.id) return refuse("cannot_report_self");
      return remoteFound(community, message.protocolId);
    }
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

async function findCommunity(reporter: Reporter, protocolId: string, inCommunity?: string): Promise<Found | CreateResult> {
  const community = await prisma.community.findUnique({ where: { protocolId }, include: { owner: true } });
  if (!community) return refuse("not_found");
  if (inCommunity !== undefined && community.protocolId !== inCommunity) return refuse("not_found");
  const member = await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: reporter.id } }, select: { id: true } });
  if (!member && community.ownerId !== reporter.id) return refuse("not_found");
  if (community.isRemote) return remoteFound(community, community.protocolId);
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

/** A thing in a community this server only has a copy of: the report is carried to the community's home server. */
function remoteFound(community: { id: string; protocolId: string; homeserverDomain: string }, targetId: string): Found | CreateResult {
  if (!community.homeserverDomain) return refuse("remote_community");
  return {
    scope: "REMOTE",
    remote: { domain: community.homeserverDomain, communityProtocolId: community.protocolId },
    communityId: community.id,
    targetId,
    targetUserId: null,
    targetLabel: null,
    snapshot: {},
  };
}

/**
 * What another server's answer to a carried report means for the person who made it. A server that has never heard of reports answers
 * with the federation router's generic `404 not_found`, which the new endpoint never uses for its own not-found
 * (`report_target_not_found`): so that one means "that server cannot take reports from other servers yet", and the person is told what they
 * were told before relaying existed.
 */
function relayRefusal(err: unknown): CreateRefusal {
  if (!(err instanceof FederationProxyError)) return "federation_unreachable";
  const code = (err.body as { error?: unknown } | null)?.error;
  if (err.status === 404) return code === "report_target_not_found" ? "not_found" : "remote_community";
  if (err.status === 403 && code === "not_a_member") return "not_a_member";
  if (err.status === 403 && code === "federation_disabled") return "federation_disabled";
  if (err.status === 403 && code === "federation_domain_blocked") return "federation_domain_blocked";
  if (err.status === 409 && code === "already_reported") return "already_reported";
  if (err.status === 429) return "too_many_reports";
  if (err.status === 400 && code === "cannot_report_self") return "cannot_report_self";
  return "federation_unreachable";
}

/** Asks the community's home server to take the report. Reported before here: no need to ask. */
async function carryToHomeServer(
  reporter: Reporter,
  input: CreateInput,
  targetId: string,
  remote: { domain: string; communityProtocolId: string }
): Promise<"accepted" | CreateRefusal> {
  const before = await prisma.report.findUnique({
    where: { reporterId_targetKey: { reporterId: reporter.protocolId, targetKey: targetKeyOf(input.kind, targetId) } },
    select: { id: true },
  });
  if (before) return "already_reported";
  const details = cleanText(input.details, MAX_DETAILS_LENGTH);
  try {
    // Only what the person chose to say goes: the other server reads the message itself, from its own copy.
    await proxyToHomeServer(remote.domain, `/communities/${remote.communityProtocolId}/reports`, {
      method: "POST",
      body: { username: reporter.username, kind: input.kind, id: input.id, reason: input.reason, ...(details ? { details } : {}) },
      timeoutMs: REPORT_RELAY_TIMEOUT_MS,
      attempts: REPORT_RELAY_ATTEMPTS,
    });
    return "accepted";
  } catch (err) {
    return relayRefusal(err);
  }
}

export interface CreateOptions {
  /** A report that arrived from another server about this community: only its own messages and itself can be reported. */
  inCommunity?: string;
}

/**
 * Records one report. Nothing is said to the person reported, and nothing is written to the audit log (a community's managers can read it,
 * and they need not be reviewers). The limits are counted in the database, so they hold across replicas.
 */
export async function createReport(reporter: Reporter, input: CreateInput, options: CreateOptions = {}): Promise<CreateResult> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [lastHour, open, fromTheirServer] = await Promise.all([
    prisma.report.count({ where: { reporterId: reporter.protocolId, createdAt: { gte: hourAgo } } }),
    // A record of a report carried to another server is never closed here, so it is not "open" here.
    prisma.report.count({ where: { reporterId: reporter.protocolId, status: "OPEN", scope: { not: "REMOTE" } } }),
    // Another server's people are counted together as well: it could make up as many as it likes.
    reporter.isRemote ? prisma.report.count({ where: { reporterDomain: reporter.homeserverDomain, createdAt: { gte: hourAgo } } }) : 0,
  ]);
  if (lastHour >= MAX_REPORTS_PER_HOUR || open >= MAX_OPEN_REPORTS || fromTheirServer >= MAX_REPORTS_PER_DOMAIN_PER_HOUR) return refuse("too_many_reports");

  const found =
    input.kind === "message"
      ? await findMessage(reporter, input.id, options.inCommunity)
      : input.kind === "user"
        ? await findUser(reporter, input.id)
        : await findCommunity(reporter, input.id, options.inCommunity);
  if (isRefusal(found)) return found;

  const relayed = found.remote ? await carryToHomeServer(reporter, input, found.targetId, found.remote) : null;
  if (relayed && relayed !== "accepted" && relayed !== "already_reported") return refuse(relayed);

  try {
    await prisma.report.create({
      data: {
        protocolId: newProtocolId(),
        kind: input.kind === "message" ? "MESSAGE" : input.kind === "user" ? "USER" : "COMMUNITY",
        scope: found.scope,
        reason: input.reason,
        // The words went to the other server; this server keeps only that a report was made.
        details: found.remote ? null : cleanText(input.details, MAX_DETAILS_LENGTH),
        reporterId: reporter.protocolId,
        reporterLabel: identityOf(reporter),
        reporterDomain: reporter.isRemote ? reporter.homeserverDomain : null,
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
  // The other server already had it: it is known here now too, and the person is told so.
  return relayed === "already_reported" ? refuse("already_reported") : { ok: true };
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
  // A record that a report was carried to another server is in no queue here: nobody on this server can act on it or close it.
  const within: Prisma.ReportWhereInput =
    scope.type === "community" ? { scope: "COMMUNITY", communityId: scope.communityId } : { scope: { not: "REMOTE" } };
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
    where: {
      reporterId: { in: reporterIds },
      ...(scope.type === "community" ? { scope: "COMMUNITY", communityId: scope.communityId } : { scope: { not: "REMOTE" } }),
    },
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

/**
 * How many reports are waiting for this reviewer: the same question `listReports` answers as `open`, through the same `visibleTo`, so a
 * count can never include a report the reviewer could not open (one about themself, another community's, or the text-free record of one
 * carried to another server).
 */
export async function countOpenReports(scope: QueueScope, viewer: Reviewer): Promise<number> {
  return prisma.report.count({ where: { AND: [visibleTo(scope, viewer), { status: "OPEN" }] } });
}

async function findVisible(scope: QueueScope, viewer: Reviewer, protocolId: string): Promise<Report | null> {
  return prisma.report.findFirst({ where: { AND: [visibleTo(scope, viewer), { protocolId }] } });
}

// ---- the messages around a reported one ---------------------------------------------------------------------------------------

/** How many messages either side of the reported one a reviewer is shown. */
export const CONTEXT_SIDE = 5;
const MAX_CONTEXT_TEXT = 500;

export interface ReportContextMessage {
  id: string;
  sender: { identity: string | null; displayName: string | null };
  /** Cut short; null for a message that has since been deleted. */
  text: string | null;
  attachmentCount: number;
  at: string;
  reported: boolean;
}

/**
 * `same`: it reads as it did when it was reported. `edited`: it was changed afterwards (the report still holds what it said then).
 * `deleted`: its sender or a moderator took it down. `gone`: it no longer exists (its sender's account was erased) or is not in this
 * community, and there is nothing to show around.
 */
export type ReportContext = { state: "same" | "edited" | "deleted" | "gone"; channel: string | null; messages: ReportContextMessage[] };

const GONE: ReportContext = { state: "gone", channel: null, messages: [] };

/**
 * The live channel around the message a COMMUNITY report is about, so a reviewer can judge it in context. Only a community's reviewers
 * ask this, never the admins: an admin is shown what was reported and nothing else of a conversation. The messages are text only (no
 * reactions, pictures or link previews), cut short, and anything deleted since is shown as gone. The report itself is not changed, and
 * looking is not an action (nothing is audited), the same as reading the queue.
 */
export async function reportContext(scope: QueueScope, viewer: Reviewer, protocolId: string): Promise<ReportContext | null> {
  if (scope.type !== "community") return null;
  const report = await findVisible(scope, viewer, protocolId);
  // A community's queue holds only reports about messages in it (`visibleTo`), so `targetId` is a message's.
  if (!report) return null;

  const include = { sender: true, attachments: { select: { id: true } } } as const;
  const message = await prisma.message.findUnique({ where: { protocolId: report.targetId }, include: { ...include, channel: true } });
  if (!message || !message.channel || message.channel.communityId !== scope.communityId) return GONE;

  const [before, after] = await Promise.all([
    prisma.message.findMany({ where: { channelId: message.channelId, createdAt: { lt: message.createdAt } }, orderBy: { createdAt: "desc" }, take: CONTEXT_SIDE, include }),
    prisma.message.findMany({ where: { channelId: message.channelId, createdAt: { gt: message.createdAt } }, orderBy: { createdAt: "asc" }, take: CONTEXT_SIDE, include }),
  ]);
  const around = [...before.reverse(), message, ...after];

  const reportedEdit = (report.snapshot as { editedAt?: string | null } | null)?.editedAt ?? null;
  const nowEdit = message.editedAt ? message.editedAt.toISOString() : null;
  return {
    state: message.deletedAt ? "deleted" : nowEdit !== reportedEdit ? "edited" : "same",
    channel: cleanLine(message.channel.name),
    messages: around.map((m) => ({
      id: m.protocolId,
      sender: { identity: cleanLine(identityOf(m.sender)), displayName: cleanLine(m.sender.displayName) },
      text: m.deletedAt ? null : cleanText(m.content, MAX_CONTEXT_TEXT),
      attachmentCount: m.deletedAt ? 0 : m.attachments.length,
      at: m.createdAt.toISOString(),
      reported: m.protocolId === message.protocolId,
    })),
  };
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
  // What this server kept of a report it carried to another server is only that the person made it: it goes with them.
  await prisma.report.deleteMany({ where: { reporterId: userProtocolId, scope: "REMOTE" } });
  await prisma.report.updateMany({ where: { reporterId: userProtocolId }, data: { reporterId: null, reporterLabel: ERASED_LABEL, reporterDomain: null } });
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
