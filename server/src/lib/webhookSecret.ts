import crypto from "node:crypto";
import { sha256Hex } from "./hash.js";

// The secret of an incoming webhook (#132, phase 2): `mcw_` and 43 characters of base64url (32 random bytes, 256 bits). It is the last part of
// the address the webhook is posted to, shown to the manager who makes it once, and only its SHA-256 is kept, so a copy of the database does
// not hold a working address. A fast hash is right here for the same reason as a bot's token: nobody chose it, so there is nothing to guess.
// The prefix makes a leaked one recognisable to a secret scanner. Kept free of config.ts imports so it can be unit-tested on its own.

export const WEBHOOK_SECRET_PREFIX = "mcw_";

const SECRET_PATTERN = /^mcw_[A-Za-z0-9_-]{43}$/;

export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + crypto.randomBytes(32).toString("base64url");
}

/** Whether `value` has the shape of a secret, checked before the database is asked about it. */
export function looksLikeWebhookSecret(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

export function hashWebhookSecret(secret: string): string {
  return sha256Hex(secret);
}

/** A hash no secret produces, compared against when the webhook does not exist, so "no such webhook" costs the same as "wrong secret". */
export const NO_SUCH_WEBHOOK_HASH = sha256Hex("no such webhook");

/** Whether the hash of what was presented equals the stored one, in constant time. */
export function secretMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashWebhookSecret(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
