import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireAdminTwoFactor } from "../../middleware/admin.js";
import { adminLimiter } from "../../middleware/rateLimit.js";
import { isAuditAction, isAuditSource } from "../../lib/auditActions.js";
import { listAudit } from "../audit/service.js";

// The admin API (#206). EVERYTHING here sits behind requireAdmin, which answers 404 to everyone who is not an admin, so nothing below can be
// told to exist from outside; the rate limit comes after it for the same reason. What it offers is metadata about the server and the
// things people did to it: no messages, no direct messages, no attachments, and never a password hash, a 2FA secret or a token.
export const adminRouter = Router();
adminRouter.use(requireAdmin, adminLimiter);

// Whether the signed-in admin can use the rest of it. This one answers without two-factor sign-in, so the page can say what is missing.
adminRouter.get("/me", (req, res) => {
  res.json({ admin: true, twoFactor: req.adminTwoFactor === true });
});

const auditQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  action: z.string().refine(isAuditAction, "an action the log knows").optional(),
  source: z.string().refine(isAuditSource, "a source the log knows").optional(),
  community: z.string().min(1).max(100).optional(),
  actor: z.string().min(1).max(100).optional(),
  target: z.string().min(1).max(100).optional(),
});

// Everything that was done, newest first (#59): moderation in every community and what operators did. Ids and labels only.
adminRouter.get("/audit-log", requireAdminTwoFactor, async (req, res) => {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { community, actor, target, ...rest } = parsed.data;
  res.json(await listAudit({ ...rest, communityId: community, actorUserId: actor, targetId: target }));
});
