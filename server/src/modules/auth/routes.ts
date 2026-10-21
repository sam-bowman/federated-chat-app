import { defaultDiscoverable } from "../../lib/userDiscoverability.js";
import { defaultListed } from "../../lib/directoryPeople.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { newProtocolId } from "../../lib/ids.js";
import { publicUser } from "../../lib/serialize.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { isPasswordBreached } from "../../lib/passwordBreachCheck.js";
import { passwordSchema } from "../../lib/passwordPolicy.js";

export { passwordSchema };
import { requireAuth } from "../../middleware/auth.js";
import type { RegistrationInvite } from "@prisma/client";
import { checkRegistrationInvite, createAccount, registrationRefusalStatus } from "./registrationInviteService.js";
import { beginTotpSetup, confirmTotpSetup, disableTotp, verifyTotpLogin } from "./totp.js";
import {
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  signAccessToken,
  signTotpChallengeToken,
  verifyPassword,
  verifyTotpChallengeToken,
} from "../../lib/auth.js";

export const authRouter = Router();

const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9_]+$/, "username must be lowercase letters, digits, or underscores");

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().min(1).max(64).optional(),
  // Only read when the server is invite-only (REGISTRATION_INVITE_ONLY); otherwise ignored, and never used up.
  inviteCode: z.string().max(64).optional(),
});

authRouter.post("/register", async (req, res) => {
  if (!config.registrationEnabled) {
    return res.status(403).json({ error: "registration_disabled" });
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  }
  const { username, password, displayName, inviteCode } = parsed.data;

  // On an invite-only server the code is judged FIRST, before anything that would tell a stranger something: a taken
  // username, a breached password. It is only spent once the account exists (createAccount).
  let invite: RegistrationInvite | null = null;
  if (config.registrationInviteOnly) {
    const checked = await checkRegistrationInvite(inviteCode);
    if (!checked.ok) return res.status(403).json({ error: checked.error });
    invite = checked.invite;
  }

  const existing = await findLocalUserByUsername(username);
  if (existing) {
    return res.status(409).json({ error: "username_taken" });
  }

  // A real network call (to the Have I Been Pwned API, fails open - see
  // passwordBreachCheck.ts) kept separate from the sync zod checks above
  // on purpose: schema validation should stay fast and pure, and this is
  // the one part of registration that depends on an external service.
  if (config.passwordBreachCheckEnabled && (await isPasswordBreached(password))) {
    return res.status(400).json({ error: "password_breached" });
  }

  const passwordHash = await hashPassword(password);
  const created = await createAccount(
    {
      protocolId: newProtocolId(),
      username,
      passwordHash,
      displayName: displayName ?? username,
      homeserverDomain: config.domain,
      discoverable: defaultDiscoverable(config.userDiscoverability),
      // What this server starts new accounts with (each can change it): who may contact them, and whether they are listed.
      contactPolicy: config.contactPolicyDefault,
      listedInDirectory: defaultListed(config.directoryPeople),
    },
    invite
  );
  // Someone else used the last use (or it was revoked), or took the username, between the checks above and now.
  if (!created.ok) return res.status(registrationRefusalStatus(created.error)).json({ error: created.error });
  const user = created.user;

  const { accessToken, refreshToken } = await issueTokens(user.id, user.username);
  res.status(201).json({ user: publicUser(user, user.id), accessToken, refreshToken });
});

const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const { username, password } = parsed.data;

  const user = await findLocalUserByUsername(username);
  if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  // Only said once the password is right, so nobody learns an account is suspended without knowing it.
  if (user.suspendedAt) return res.status(403).json({ error: "account_suspended" });

  if (user.totpEnabled) {
    // Hand back a short-lived challenge token instead of real tokens -
    // POST /2fa/login redeems it once the code (or a recovery code) checks
    // out. See signTotpChallengeToken()'s own comment for why this can
    // never be mistaken for a real access token.
    return res.json({ totpRequired: true, challengeToken: signTotpChallengeToken(user.id) });
  }

  const { accessToken, refreshToken } = await issueTokens(user.id, user.username);
  res.json({ user: publicUser(user, user.id), accessToken, refreshToken });
});

const totpLoginSchema = z
  .object({
    challengeToken: z.string().min(1),
    code: z.string().min(1).optional(),
    recoveryCode: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.code || data.recoveryCode), {
    message: "code or recoveryCode is required",
    path: ["code"],
  });

authRouter.post("/2fa/login", async (req, res) => {
  const parsed = totpLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  }

  let userId: string;
  try {
    ({ sub: userId } = verifyTotpChallengeToken(parsed.data.challengeToken));
  } catch {
    return res.status(401).json({ error: "invalid_challenge_token" });
  }

  // The challenge token proves the password was right, so a suspended account can be told; and its code is not spent on this.
  const account = await prisma.user.findUnique({ where: { id: userId }, select: { suspendedAt: true } });
  if (account?.suspendedAt) return res.status(403).json({ error: "account_suspended" });

  const ok = await verifyTotpLogin(userId, { code: parsed.data.code, recoveryCode: parsed.data.recoveryCode });
  if (!ok) {
    return res.status(401).json({ error: "invalid_code" });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return res.status(401).json({ error: "invalid_challenge_token" });
  }

  const { accessToken, refreshToken } = await issueTokens(user.id, user.username);
  res.json({ user: publicUser(user, user.id), accessToken, refreshToken });
});

const totpPasswordSchema = z.object({ password: z.string().min(1) });

// Password re-confirmation here (not just the already-valid access token)
// matters specifically because a hijacked session could otherwise enroll
// or disable 2FA on its own - enrolling with an attacker-controlled secret
// would silently lock the real owner out of their next login, and
// disabling removes their protection outright. Neither should be possible
// with just a stolen access token.
authRouter.post("/2fa/setup", requireAuth, async (req, res) => {
  const parsed = totpPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user?.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  if (user.totpEnabled) {
    return res.status(409).json({ error: "totp_already_enabled" });
  }

  const setup = await beginTotpSetup(user.id, user.username);
  res.json(setup);
});

const totpCodeSchema = z.object({ code: z.string().min(1) });

authRouter.post("/2fa/verify", requireAuth, async (req, res) => {
  const parsed = totpCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const recoveryCodes = await confirmTotpSetup(req.userId!, parsed.data.code);
  if (recoveryCodes === null) {
    return res.status(400).json({ error: "invalid_code" });
  }
  res.json({ recoveryCodes });
});

authRouter.post("/2fa/disable", requireAuth, async (req, res) => {
  const parsed = totpPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user?.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  await disableTotp(user.id);
  res.status(204).end();
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

authRouter.post("/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const tokenHash = hashRefreshToken(parsed.data.refreshToken);
  const stored = await prisma.refreshToken.findFirst({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    include: { user: true },
  });
  if (!stored) {
    return res.status(401).json({ error: "invalid_refresh_token" });
  }

  // A suspended account's sessions end here (suspending also revokes them; this covers one made in between). The token is left
  // alone, so unsuspending brings the session back.
  if (stored.user.suspendedAt) return res.status(403).json({ error: "account_suspended" });

  // Rotate: revoke the used token and issue a new pair.
  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  const { accessToken, refreshToken } = await issueTokens(stored.user.id, stored.user.username);
  res.json({ accessToken, refreshToken });
});

authRouter.post("/logout", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (parsed.success) {
    const tokenHash = hashRefreshToken(parsed.data.refreshToken);
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  res.status(204).end();
});

async function issueTokens(userId: string, username: string) {
  const accessToken = signAccessToken({ sub: userId, username });
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt,
    },
  });
  return { accessToken, refreshToken };
}
