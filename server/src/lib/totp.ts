import { generate, generateSecret, generateURI, verify } from "otplib";

export function generateTotpSecret(): string {
  return generateSecret();
}

/** otpauth:// URI for rendering as a QR code during setup - see client's SettingsPage. */
export function totpAuthUri(secret: string, username: string, issuer: string): string {
  return generateURI({ issuer, label: username, secret });
}

export function generateTotpCode(secret: string): Promise<string> {
  return generate({ secret });
}

export interface TotpVerifyResult {
  valid: boolean;
  /** The absolute 30-second time-step the code matched, only present when valid. Persist as the next afterTimeStep. */
  timeStep?: number;
}

/**
 * Verifies a 6-digit TOTP code against `secret`. `epochTolerance: 30`
 * allows +-30s (one step) of clock drift between server and authenticator
 * app, the tolerance RFC 6238 S5.2 recommends. `afterTimeStep`, when given,
 * rejects that step or any earlier one - pass the account's last-accepted
 * step (User.totpLastUsedStep) to stop the exact same code being replayed
 * within its own still-valid window.
 */
export async function verifyTotpCode(
  secret: string,
  code: string,
  afterTimeStep?: number | null
): Promise<TotpVerifyResult> {
  try {
    const result = await verify({
      secret,
      token: code,
      epochTolerance: 30,
      afterTimeStep: afterTimeStep ?? undefined,
    });
    // otplib's verify() return type is shared with HOTP (which has no
    // timeStep, only counter) since both go through the same functional
    // API - narrow explicitly rather than relying on `result.valid` alone,
    // which TypeScript can't use to eliminate the HOTP-shaped branch.
    return result.valid && "timeStep" in result ? { valid: true, timeStep: result.timeStep } : { valid: false };
  } catch {
    // A malformed code (non-digit, wrong length) throws rather than
    // returning {valid:false} - never let that reach the caller as a 500.
    return { valid: false };
  }
}
