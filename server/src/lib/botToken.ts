import crypto from "node:crypto";
import { sha256Hex } from "./hash.js";

// A bot's credential (#132): `mcb_` and 43 characters of base64url (32 random bytes, 256 bits). It is shown to the person who makes the bot
// once and only its SHA-256 is kept, so a copy of the database does not hold a working token. A fast hash is right here, unlike a password:
// the token is not chosen by a person, so there is nothing to guess and nothing for a slow hash to slow down. Kept free of config.ts imports so
// it can be unit-tested on its own.

export const BOT_TOKEN_PREFIX = "mcb_";
/** The scheme of the `Authorization` header: `Authorization: Bot <token>`. */
export const BOT_AUTH_SCHEME = "Bot ";

const TOKEN_PATTERN = /^mcb_[A-Za-z0-9_-]{43}$/;

export function generateBotToken(): string {
  return BOT_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
}

/** Whether `value` has the shape of a token, checked before the database is asked about it. */
export function looksLikeBotToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function hashBotToken(token: string): string {
  return sha256Hex(token);
}

/** The token in an `Authorization` header value, or null when the header is not the Bot scheme. */
export function botTokenFromHeader(header: string | undefined): string | null {
  if (!header?.startsWith(BOT_AUTH_SCHEME)) return null;
  return header.slice(BOT_AUTH_SCHEME.length).trim();
}
