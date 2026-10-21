import crypto from "node:crypto";
import jwt from "jsonwebtoken";

// "Sudo mode" for the admin page (#206): destructive actions need a RECENT proof that the person at the keyboard is the admin, not just a
// session that may have been stolen. The page asks for the password and a code from the authenticator, and the server answers with a short-lived
// token that the page sends with each destructive request (the X-Admin-Sudo header). It lasts ten minutes and is never stored: the page keeps
// it in memory only.
//
// It is signed with a key DERIVED from the access-token secret under a label of its own (as the two-factor challenge token is), so it can never
// pass as an access token, a challenge token or anything else, and none of those can pass as one: the signature simply does not verify under
// the wrong key. And it names the admin it was made for: one admin's token is no good to another.
//
// Kept free of config.ts imports (the secret is an argument) so it can be unit-tested on its own.

export const SUDO_TTL_SECONDS = 10 * 60;

interface SudoPayload {
  purpose: "admin_sudo";
  sub: string; // the admin's user id
}

function sudoKey(accessSecret: string): string {
  return crypto.createHmac("sha256", accessSecret).update("admin-sudo:v1").digest("hex");
}

/** A token for this admin, good for `SUDO_TTL_SECONDS`, and when that is. */
export function signSudoToken(accessSecret: string, userId: string, now: Date = new Date()): { token: string; expiresAt: Date } {
  const issued = Math.floor(now.getTime() / 1000);
  const payload: SudoPayload & { iat: number; exp: number } = { purpose: "admin_sudo", sub: userId, iat: issued, exp: issued + SUDO_TTL_SECONDS };
  return { token: jwt.sign(payload, sudoKey(accessSecret)), expiresAt: new Date((issued + SUDO_TTL_SECONDS) * 1000) };
}

/** Whether `token` is a valid, unexpired sudo token made for exactly this admin. Never throws. */
export function isValidSudoToken(accessSecret: string, token: string | undefined, userId: string, now: Date = new Date()): boolean {
  if (!token) return false;
  try {
    const payload = jwt.verify(token, sudoKey(accessSecret), { algorithms: ["HS256"], clockTimestamp: Math.floor(now.getTime() / 1000) }) as Partial<SudoPayload>;
    return payload.purpose === "admin_sudo" && payload.sub === userId;
  } catch {
    return false;
  }
}
