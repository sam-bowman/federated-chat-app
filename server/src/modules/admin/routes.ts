import type { Request, Response } from "express";
import { Router } from "express";
import type { User } from "../../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAdmin, requireAdminTwoFactor, requireSudo } from "../../middleware/admin.js";
import { adminLimiter, authLimiter } from "../../middleware/rateLimit.js";
import { isAuditAction, isAuditSource } from "../../lib/auditActions.js";
import { verifyPassword } from "../../lib/auth.js";
import { signSudoToken } from "../../lib/adminSudo.js";
import { passwordSchema } from "../../lib/passwordPolicy.js";
import {
  DEFAULT_EXPIRY_DAYS,
  DEFAULT_MAX_USES,
  MAX_CODES_PER_CREATE,
  MAX_EXPIRY_DAYS,
  MAX_NOTE_LENGTH,
  MAX_REGISTRATION_USES,
} from "../../lib/registrationInvites.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { verifyTotpLogin } from "../auth/totp.js";
import { listAudit } from "../audit/service.js";
import { registerQueueRoutes } from "../reports/routes.js";
import { getOverview } from "./overview.js";
import { createRegistrationInvites, listRegistrationInvites, revokeRegistrationInvite } from "./registrationInvites.js";
import {
  MAX_COMMUNITY_PAGE,
  MAX_USER_PAGE,
  cancelUserDeletion,
  deleteCommunityByOperator,
  deleteUser,
  disableTwoFactor,
  getCommunity,
  getUser,
  listCommunitiesPage,
  listUsersPage,
  resetPassword,
  setAdmin,
  suspendUser,
  transferCommunityByOperator,
  unsuspendUser,
  type AdminContext,
  type CommunityDetail,
  type CommunitySummary,
} from "./service.js";
import { param } from "../../lib/params.js";

// The admin API (#206). EVERYTHING here sits behind requireAdmin, which answers 404 to everyone who is not an admin, so nothing below can be
// told to exist from outside; the rate limit comes after it for the same reason. What it offers is metadata about the server and the
// things people did to it: no messages, no direct messages, no attachments, and never a password hash, a 2FA secret or a token.
export const adminRouter = Router();
adminRouter.use(requireAdmin, adminLimiter);

// Whether the signed-in admin can use the rest of it. This one answers without two-factor sign-in, so the page can say what is missing.
adminRouter.get("/me", (req, res) => {
  res.json({ admin: true, twoFactor: req.adminTwoFactor === true });
});

// ---- the overview ----------------------------------------------------------------------------------------------------------------

// What this server is, how it is set up and how busy it is: counts and switches, nothing anyone wrote and no secret (see overview.ts).
adminRouter.get("/overview", requireAdminTwoFactor, async (_req, res) => {
  res.json({ overview: await getOverview() });
});

// ---- the audit log ---------------------------------------------------------------------------------------------------------------

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

// The reports that reach this server (#58): what community moderators see, plus what only the admins can (direct messages, people,
// communities). Closing and reopening need the two-factor sign-in but not sudo mode: they change nothing but the report, and what has
// consequences (suspending, deleting) keeps its own sudo requirement.
registerQueueRoutes(adminRouter, "/reports", [requireAdminTwoFactor], async (req) => {
  const reviewer = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { protocolId: true, username: true, homeserverDomain: true } });
  return { scope: { type: "admin" }, ctx: { reviewer, source: "admin" } };
});

// ---- sudo mode -------------------------------------------------------------------------------------------------------------------

const sudoSchema = z
  .object({ password: z.string().min(1), code: z.string().min(1).optional(), recoveryCode: z.string().min(1).optional() })
  .refine((v) => Boolean(v.code || v.recoveryCode), { message: "a code or a recovery code is required" });

// Proves, again, that the person at the keyboard is the admin (their password and a code from their authenticator) and answers with a token
// good for ten minutes, which every action that changes something must send. Behind the sign-in limiter: it is a way to guess a password.
adminRouter.post("/sudo", requireAdminTwoFactor, authLimiter, async (req, res) => {
  const parsed = sudoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const admin = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!admin?.passwordHash || !(await verifyPassword(parsed.data.password, admin.passwordHash))) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  if (!(await verifyTotpLogin(admin.id, { code: parsed.data.code, recoveryCode: parsed.data.recoveryCode }))) {
    return res.status(401).json({ error: "invalid_code" });
  }
  const { token, expiresAt } = signSudoToken(config.jwtAccessSecret, admin.id);
  res.json({ sudoToken: token, expiresAt });
});

// ---- accounts --------------------------------------------------------------------------------------------------------------------

const boolFlag = z.enum(["1", "true", "0", "false"]).transform((v) => v === "1" || v === "true");
const userListSchema = z.object({
  search: z.string().max(100).optional(),
  suspended: boolFlag.optional(),
  admin: boolFlag.optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_USER_PAGE).optional(),
});

// The accounts on THIS server (a cached copy of someone else's is not ours to manage), a page at a time.
adminRouter.get("/users", requireAdminTwoFactor, async (req, res) => {
  const parsed = userListSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { suspended, ...rest } = parsed.data;
  res.json(await listUsersPage({ ...rest, suspendedOnly: suspended }));
});

adminRouter.get("/users/:username", requireAdminTwoFactor, async (req, res) => {
  const user = await getUser(param(req, "username"));
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ user });
});

/**
 * The account an action is about, and who is doing it. An account that is an ADMIN can only be changed in one way from here (taking admin
 * away): suspending, deleting, resetting the password or turning off 2FA of an admin is the command's alone. Otherwise an admin whose session was
 * taken could lock out or take over every other admin, and the way back in after a lock-out must never depend on the page. This also covers
 * "never yourself", since an admin is one. Sends the error itself and returns null when the action cannot go ahead.
 */
async function loadTarget(req: Request, res: Response, options: { adminOk?: boolean } = {}): Promise<{ target: User; admin: User; ctx: AdminContext } | null> {
  const target = await findLocalUserByUsername(param(req, "username"));
  if (!target) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (target.isAdmin && !options.adminOk) {
    res.status(409).json({ error: "target_is_admin" });
    return null;
  }
  const admin = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
  return { target, admin, ctx: { actor: { kind: "user", user: admin }, source: "admin" } };
}

const respondWithUser = async (res: Response, username: string) => res.json({ user: await getUser(username) });

const WRITE = [requireAdminTwoFactor, requireSudo] as const;

adminRouter.post("/users/:username/suspend", ...WRITE, async (req, res) => {
  const t = await loadTarget(req, res);
  if (!t) return;
  await suspendUser(t.target.username, t.ctx);
  await respondWithUser(res, t.target.username);
});

adminRouter.post("/users/:username/unsuspend", ...WRITE, async (req, res) => {
  const t = await loadTarget(req, res);
  if (!t) return;
  await unsuspendUser(t.target.username, t.ctx);
  await respondWithUser(res, t.target.username);
});

adminRouter.post("/users/:username/reset-password", ...WRITE, async (req, res) => {
  const parsed = z.object({ password: passwordSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  const t = await loadTarget(req, res);
  if (!t) return;
  await resetPassword(t.target.username, parsed.data.password, t.ctx);
  await respondWithUser(res, t.target.username);
});

adminRouter.post("/users/:username/disable-2fa", ...WRITE, async (req, res) => {
  const t = await loadTarget(req, res);
  if (!t) return;
  await disableTwoFactor(t.target.username, t.ctx);
  await respondWithUser(res, t.target.username);
});

// Asks for the account to be deleted, as the person could (sessions end, a grace period starts, signing in cancels it); with `now` it is erased
// at once, which cannot be undone and so also needs the username typed out. Refused while the account owns a community.
const deleteSchema = z.object({ now: z.boolean().optional(), confirm: z.string().max(100).optional() });

adminRouter.post("/users/:username/delete", ...WRITE, async (req, res) => {
  const parsed = deleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const t = await loadTarget(req, res);
  if (!t) return;
  const now = parsed.data.now === true;
  if (now && parsed.data.confirm?.trim().toLowerCase() !== t.target.username) return res.status(400).json({ error: "confirm_mismatch" });

  const result = await deleteUser(t.target.username, { now }, t.ctx);
  if (!result.ok) {
    if (result.error === "owns_communities") return res.status(409).json({ error: "owns_communities", communities: result.communities });
    return res.status(404).json({ error: "not_found" });
  }
  if (result.mode === "erased") return res.json({ erased: true });
  await respondWithUser(res, t.target.username);
});

adminRouter.post("/users/:username/cancel-deletion", ...WRITE, async (req, res) => {
  const t = await loadTarget(req, res);
  if (!t) return;
  await cancelUserDeletion(t.target.username, t.ctx);
  await respondWithUser(res, t.target.username);
});

// Makes someone an admin, or takes it away: the one change allowed on an admin account. Never your own (so the last admin cannot be removed
// from here). Making the FIRST admin is the command's alone, as everything that needs no admin to exist.
adminRouter.put("/users/:username/admin", ...WRITE, async (req, res) => {
  const parsed = z.object({ admin: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const t = await loadTarget(req, res, { adminOk: true });
  if (!t) return;
  if (t.target.id === t.admin.id) return res.status(409).json({ error: "cannot_change_own_admin" });
  if (parsed.data.admin && t.target.suspendedAt) return res.status(409).json({ error: "target_suspended" });
  await setAdmin(t.target.username, parsed.data.admin, t.ctx);
  await respondWithUser(res, t.target.username);
});

// ---- registration invites --------------------------------------------------------------------------------------------------------

// The codes an invite-only server asks for. Seeing them needs two-factor sign-in (as the command's `list` needs being on the server); making and
// revoking one also needs sudo. A code is a credential, so it is in no URL and no audit entry: revoking names the invite by its id.
const registrationInviteSchema = z.object({
  maxUses: z.number().int().min(1).max(MAX_REGISTRATION_USES).nullable().default(DEFAULT_MAX_USES),
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).nullable().default(DEFAULT_EXPIRY_DAYS),
  note: z
    .string()
    .max(MAX_NOTE_LENGTH * 4)
    .transform((n) => n.trim())
    .refine((n) => n.length <= MAX_NOTE_LENGTH, "too long")
    .nullable()
    .optional(),
  count: z.number().int().min(1).max(MAX_CODES_PER_CREATE).default(1),
});

adminRouter.get("/registration-invites", requireAdminTwoFactor, async (req, res) => {
  const parsed = z.object({ all: boolFlag.optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const page = await listRegistrationInvites({ all: parsed.data.all });
  // Whether the codes matter at all right now, so the page can say so instead of leaving people to wonder.
  res.json({ ...page, registration: { enabled: config.registrationEnabled, inviteOnly: config.registrationInviteOnly } });
});

adminRouter.post("/registration-invites", ...WRITE, async (req, res) => {
  const parsed = registrationInviteSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  const { note, ...rest } = parsed.data;
  const admin = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
  const invites = await createRegistrationInvites({ ...rest, note: note ? note : null }, { actor: { kind: "user", user: admin }, source: "admin" });
  res.status(201).json({ invites });
});

adminRouter.post("/registration-invites/:id/revoke", ...WRITE, async (req, res) => {
  const admin = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
  const result = await revokeRegistrationInvite({ id: param(req, "id") }, { actor: { kind: "user", user: admin }, source: "admin" });
  if (!result.ok) return res.status(404).json({ error: "not_found" });
  res.json({ invite: result.invite });
});

// ---- communities -----------------------------------------------------------------------------------------------------------------

// The communities this server HOSTS (a cached copy of another server's is theirs). What an admin needs to decide what to do: who owns it, how
// big it is, who can join. Field by field, and NO description, channel, message or member list: nothing anyone wrote in it.
const communityListItem = (c: CommunitySummary) => ({ id: c.id, name: c.name, owner: c.owner, members: c.members, channels: c.channels, visibility: c.visibility, createdAt: c.createdAt });
const communityDetailItem = (c: CommunityDetail) => ({
  ...communityListItem(c),
  localMembers: c.localMembers,
  remoteMembers: c.remoteMembers,
  remoteDomains: c.remoteDomains,
  textChannels: c.textChannels,
  voiceChannels: c.voiceChannels,
});

const communityListSchema = z.object({
  search: z.string().max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_COMMUNITY_PAGE).optional(),
});

adminRouter.get("/communities", requireAdminTwoFactor, async (req, res) => {
  const parsed = communityListSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const page = await listCommunitiesPage(parsed.data);
  res.json({ communities: page.communities.map(communityListItem), total: page.total });
});

adminRouter.get("/communities/:id", requireAdminTwoFactor, async (req, res) => {
  const community = await getCommunity(param(req, "id"));
  if (!community || community.hosting !== "here") return res.status(404).json({ error: "not_found" });
  res.json({ community: communityDetailItem(community) });
});

/** The admin who is acting, as the audit log should name them. */
async function adminContext(req: Request): Promise<AdminContext> {
  const admin = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
  return { actor: { kind: "user", user: admin }, source: "admin" };
}

const respondWithCommunity = async (res: Response, id: string) => res.json({ community: communityDetailItem((await getCommunity(id))!) });

/** What each reason a transfer cannot happen is answered with (the codes are the ones the owner's own route uses, where they exist). */
const TRANSFER_REFUSALS: Record<Extract<Awaited<ReturnType<typeof transferCommunityByOperator>>, { ok: false }>["error"], [number, string]> = {
  no_such_community: [404, "not_found"],
  not_hosted_here: [409, "not_hosted_here"],
  no_such_user: [404, "user_not_found"],
  target_suspended: [409, "target_suspended"],
  new_owner_must_be_local: [400, "new_owner_must_be_local"],
  already_owner: [400, "already_owner"],
  not_a_member: [404, "not_a_member"],
  ownership_changed: [409, "ownership_changed"],
};

// Hands the community to one of its members, by username: the admin's way when the owner cannot or will not (for instance an account that is
// being closed, which cannot be deleted while it owns one). Nothing else about the old owner changes.
adminRouter.put("/communities/:id/owner", ...WRITE, async (req, res) => {
  const parsed = z.object({ username: z.string().trim().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const result = await transferCommunityByOperator(param(req, "id"), parsed.data.username.toLowerCase(), await adminContext(req));
  if (!result.ok) {
    const [status, error] = TRANSFER_REFUSALS[result.error];
    return res.status(status).json({ error });
  }
  await respondWithCommunity(res, param(req, "id"));
});

// Deletes it for good, with everything in it, exactly as its owner deleting it would. The name has to be typed out, since it cannot be undone.
adminRouter.post("/communities/:id/delete", ...WRITE, async (req, res) => {
  const parsed = z.object({ confirm: z.string().max(200).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const community = await getCommunity(param(req, "id"));
  if (!community) return res.status(404).json({ error: "not_found" });
  if (community.hosting !== "here") return res.status(409).json({ error: "not_hosted_here" });
  if (parsed.data.confirm?.trim().toLowerCase() !== community.name.trim().toLowerCase()) return res.status(400).json({ error: "confirm_mismatch" });
  const result = await deleteCommunityByOperator(param(req, "id"), await adminContext(req));
  if (!result.ok) return res.status(result.error === "not_hosted_here" ? 409 : 404).json({ error: result.error === "not_hosted_here" ? "not_hosted_here" : "not_found" });
  res.json({ deleted: true });
});

