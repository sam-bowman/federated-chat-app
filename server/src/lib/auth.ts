import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { config } from "../config.js";
import { sha256Hex } from "./hash.js";

export interface AccessTokenPayload {
  sub: string; // user id
  username: string;
}

// A short-lived token issued by POST /auth/login in place of real tokens
// when the account has TOTP enabled, then redeemed by POST /auth/2fa/login
// once the code (or a recovery code) checks out. Signed with a secret
// *derived* from config.jwtAccessSecret (via HMAC, not the secret itself) -
// requireAuth's verifyAccessToken() call uses jwtAccessSecret directly, so a
// challenge token can never pass as a real access token: the signature
// simply won't verify under the wrong key. No new env var needed for this.
export interface TotpChallengePayload {
  challenge: "totp_challenge";
  sub: string; // user id
}

function totpChallengeSecret(): string {
  return crypto.createHmac("sha256", config.jwtAccessSecret).update("totp-challenge:v1").digest("hex");
}

export function signTotpChallengeToken(userId: string): string {
  const payload: TotpChallengePayload = { challenge: "totp_challenge", sub: userId };
  return jwt.sign(payload, totpChallengeSecret(), { expiresIn: "5m" });
}

/** Throws if `token` isn't a validly-signed, unexpired challenge token. */
export function verifyTotpChallengeToken(token: string): { sub: string } {
  const payload = jwt.verify(token, totpChallengeSecret()) as TotpChallengePayload;
  if (payload.challenge !== "totp_challenge") {
    throw new Error("not a totp challenge token");
  }
  return { sub: payload.sub };
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.jwtAccessSecret, { expiresIn: config.accessTokenTtlSeconds });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.jwtAccessSecret) as AccessTokenPayload;
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("hex");
}

export function hashRefreshToken(token: string): string {
  return sha256Hex(token);
}
