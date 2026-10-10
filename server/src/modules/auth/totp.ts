import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { generateTotpSecret, totpAuthUri, verifyTotpCode } from "../../lib/totp.js";
import { generateRecoveryCodes, hashRecoveryCode } from "../../lib/recoveryCodes.js";

export interface TotpSetupResult {
  secret: string;
  otpauthUrl: string;
}

/**
 * Starts (or restarts) TOTP enrollment: generates a fresh secret and stores
 * it unconfirmed - totpEnabled stays false, so nothing about login changes,
 * until confirmTotpSetup() verifies the user actually scanned it. Callers
 * must reject this while totpEnabled is already true (see routes.ts) -
 * overwriting an *active* secret here would break login with the old
 * authenticator entry immediately, before the new one is ever confirmed.
 */
export async function beginTotpSetup(userId: string, username: string): Promise<TotpSetupResult> {
  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: secret, totpEnabled: false, totpLastUsedStep: null },
  });
  return { secret, otpauthUrl: totpAuthUri(secret, username, config.serverName) };
}

/** Confirms a pending secret from beginTotpSetup() and enables 2FA. Returns the plaintext recovery codes (shown once) on success, or null for a wrong code. */
export async function confirmTotpSetup(userId: string, code: string): Promise<string[] | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.totpSecret) return null;

  const result = await verifyTotpCode(user.totpSecret, code, user.totpLastUsedStep);
  if (!result.valid) return null;

  const recoveryCodes = generateRecoveryCodes();
  await prisma.$transaction([
    // Deliberately leave totpLastUsedStep untouched (null) here, not set to
    // result.timeStep - this confirmation code and the user's first real
    // *login* code can legitimately be the exact same code (TOTP is
    // deterministic per 30s step), and replay protection should guard
    // logins, not block the first one just because setup happened to use
    // the same window. Login verification (verifyTotpLogin) is what starts
    // tracking this field.
    prisma.user.update({ where: { id: userId }, data: { totpEnabled: true } }),
    // Clear any codes left over from a previous enable/disable cycle before
    // issuing a fresh set - old ones must not still work after a reset.
    prisma.totpRecoveryCode.deleteMany({ where: { userId } }),
    prisma.totpRecoveryCode.createMany({
      data: recoveryCodes.map((recoveryCode) => ({ userId, codeHash: hashRecoveryCode(recoveryCode) })),
    }),
  ]);
  return recoveryCodes;
}

export async function disableTotp(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { totpSecret: null, totpEnabled: false, totpLastUsedStep: null },
    }),
    prisma.totpRecoveryCode.deleteMany({ where: { userId } }),
  ]);
}

/**
 * Verifies a login-time 2FA code against either the TOTP secret or an
 * unused recovery code, persisting replay-prevention state on success.
 * `code` is tried first when both are given.
 */
export async function verifyTotpLogin(
  userId: string,
  { code, recoveryCode }: { code?: string; recoveryCode?: string }
): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.totpEnabled || !user.totpSecret) return false;

  if (code) {
    const result = await verifyTotpCode(user.totpSecret, code, user.totpLastUsedStep);
    if (!result.valid) return false;
    await prisma.user.update({ where: { id: userId }, data: { totpLastUsedStep: result.timeStep } });
    return true;
  }

  if (recoveryCode) {
    // A single conditional UPDATE (not findFirst-then-update) so two
    // simultaneous requests racing with the same valid code can't both
    // succeed - at most one UPDATE actually matches a still-unused row.
    const updated = await prisma.totpRecoveryCode.updateMany({
      where: { userId, codeHash: hashRecoveryCode(recoveryCode), usedAt: null },
      data: { usedAt: new Date() },
    });
    return updated.count > 0;
  }

  return false;
}
