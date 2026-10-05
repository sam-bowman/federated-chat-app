import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { newProtocolId } from "../../lib/ids.js";
import { publicUser } from "../../lib/serialize.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import {
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  signAccessToken,
  verifyPassword,
} from "../../lib/auth.js";

export const authRouter = Router();

const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9_]+$/, "username must be lowercase letters, digits, or underscores");

const registerSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8).max(256),
  displayName: z.string().min(1).max(64).optional(),
});

authRouter.post("/register", async (req, res) => {
  if (!config.registrationEnabled) {
    return res.status(403).json({ error: "registration_disabled" });
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  }
  const { username, password, displayName } = parsed.data;

  const existing = await findLocalUserByUsername(username);
  if (existing) {
    return res.status(409).json({ error: "username_taken" });
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      protocolId: newProtocolId(),
      username,
      passwordHash,
      displayName: displayName ?? username,
      homeserverDomain: config.domain,
    },
  });

  const { accessToken, refreshToken } = await issueTokens(user.id, user.username);
  res.status(201).json({ user: publicUser(user), accessToken, refreshToken });
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

  const { accessToken, refreshToken } = await issueTokens(user.id, user.username);
  res.json({ user: publicUser(user), accessToken, refreshToken });
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
