import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import {
  MAX_DETAILS_LENGTH,
  MAX_NOTE_LENGTH,
  REPORT_KINDS,
  REPORT_REASONS,
  RESOLVE_ACTIONS,
} from "../../lib/reports.js";
import { getMemberPermissions } from "../communities/memberPermissions.js";
import {
  MAX_PAGE,
  closeReport,
  countOpenReports,
  createReport,
  getReport,
  listReports,
  reopenReport,
  reportContext,
  type QueueScope,
  type ReviewerContext,
} from "./service.js";

// Reporting (any signed-in person) and the queue (a community's reviewers, and the server's admins). The same handlers serve both queues:
// `registerQueueRoutes` is given where they are mounted and a guard that says whose queue it is, or has already answered the request.

export const reportsRouter = Router();

const createSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  id: z.string().trim().min(1).max(100),
  reason: z.enum(REPORT_REASONS),
  details: z.string().max(MAX_DETAILS_LENGTH).optional(),
});

const CREATE_STATUS = {
  not_found: 404,
  remote_community: 409,
  cannot_report_self: 400,
  already_reported: 409,
  too_many_reports: 429,
  not_a_member: 403,
  federation_unreachable: 502,
  federation_disabled: 403,
  federation_domain_blocked: 403,
} as const;

// Says nothing but that it was received: no id, no state, nothing that could be used to look at it again.
reportsRouter.post("/", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const reporter = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { id: true, protocolId: true, username: true, homeserverDomain: true } });
  const result = await createReport(reporter, parsed.data);
  if (!result.ok) return res.status(CREATE_STATUS[result.error]).json({ error: result.error });
  res.status(201).json({ received: true });
});

// ---- the queue ---------------------------------------------------------------------------------------------------------------

export interface QueueAccess {
  scope: QueueScope;
  ctx: ReviewerContext;
}
export type QueueGuard = (req: Request, res: Response) => Promise<QueueAccess | null>;

const listSchema = z.object({
  status: z.enum(["open", "resolved", "dismissed"]).optional(),
  scope: z.enum(["community", "server"]).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
});
const resolveSchema = z.object({ action: z.enum(RESOLVE_ACTIONS), note: z.string().max(MAX_NOTE_LENGTH).optional() });
const dismissSchema = z.object({ note: z.string().max(MAX_NOTE_LENGTH).optional() });

const REVIEW_STATUS = { not_found: 404, not_open: 409, not_closed: 409 } as const;

/** Registers list, read, resolve, dismiss and reopen under `prefix` (`/:id/reports` for a community, `/reports` for the admins). */
export function registerQueueRoutes(router: Router, prefix: string, before: RequestHandler[], guard: QueueGuard) {
  router.get(prefix, ...before, async (req, res) => {
    const access = await guard(req, res);
    if (!access) return;
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
    // A community's moderators cannot narrow by scope: their queue is one scope.
    const filter = access.scope.type === "admin" ? parsed.data : { ...parsed.data, scope: undefined };
    res.json(await listReports(access.scope, access.ctx.reviewer, filter));
  });

  // Before `/:reportId`, which would otherwise take it for an id. Only a number: what the queue's own `open` says, without the page.
  router.get(`${prefix}/open-count`, ...before, async (req, res) => {
    const access = await guard(req, res);
    if (!access) return;
    res.json({ open: await countOpenReports(access.scope, access.ctx.reviewer) });
  });

  router.get(`${prefix}/:reportId`, ...before, async (req, res) => {
    const access = await guard(req, res);
    if (!access) return;
    const report = await getReport(access.scope, access.ctx.reviewer, req.params.reportId);
    if (!report) return res.status(404).json({ error: "not_found" });
    res.json({ report });
  });

  router.post(`${prefix}/:reportId/resolve`, ...before, async (req, res) => {
    const access = await guard(req, res);
    if (!access) return;
    const parsed = resolveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
    const result = await closeReport(access.scope, access.ctx, req.params.reportId, { status: "RESOLVED", ...parsed.data });
    if (!result.ok) return res.status(REVIEW_STATUS[result.error]).json({ error: result.error });
    res.json({ report: result.report });
  });

  router.post(`${prefix}/:reportId/dismiss`, ...before, async (req, res) => {
    const access = await guard(req, res);
    if (!access) return;
    const parsed = dismissSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
    const result = await closeReport(access.scope, access.ctx, req.params.reportId, { status: "DISMISSED", ...parsed.data });
    if (!result.ok) return res.status(REVIEW_STATUS[result.error]).json({ error: result.error });
    res.json({ report: result.report });
  });

  router.post(`${prefix}/:reportId/reopen`, ...before, async (req, res) => {
    const access = await guard(req, res);
    if (!access) return;
    const result = await reopenReport(access.scope, access.ctx, req.params.reportId);
    if (!result.ok) return res.status(REVIEW_STATUS[result.error]).json({ error: result.error });
    res.json({ report: result.report });
  });
}

// ---- a community's queue ------------------------------------------------------------------------------------------------------

export const communityReportsRouter = Router();

const communityGuard: QueueGuard = async (req, res) => {
  const community = await prisma.community.findUnique({ where: { protocolId: req.params.id } });
  if (!community) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  // Only a community hosted here has reports: those about a copy of someone else's are refused when they are made.
  if (community.isRemote) {
    res.status(409).json({ error: "remote_community_management_not_supported" });
    return null;
  }
  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.REVIEW_REPORTS)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  const reviewer = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { protocolId: true, username: true, homeserverDomain: true } });
  return { scope: { type: "community", communityId: community.id }, ctx: { reviewer, source: "api" } };
};

registerQueueRoutes(communityReportsRouter, "/:id/reports", [requireAuth], communityGuard);

// The messages around a reported one, as they are now. A community's reviewers only: the admins' queue has no such route, because an admin
// is shown what was reported and not the conversation around it.
communityReportsRouter.get("/:id/reports/:reportId/context", requireAuth, async (req, res) => {
  const access = await communityGuard(req, res);
  if (!access) return;
  const context = await reportContext(access.scope, access.ctx.reviewer, req.params.reportId);
  if (!context) return res.status(404).json({ error: "not_found" });
  res.json({ context });
});
