import { getNonceRedisClient } from "../redis.js";
import { InMemoryNonceCache, RedisNonceCache, type NonceCache } from "./nonceCacheAdapters.js";

export type { NonceCache } from "./nonceCacheAdapters.js";

let cache: NonceCache | undefined;

function getNonceCache(): NonceCache {
  if (!cache) {
    const redisClient = getNonceRedisClient();
    cache = redisClient ? new RedisNonceCache(redisClient) : new InMemoryNonceCache();
  }
  return cache;
}

/** Test-only: forces the next checkAndRecordNonce() call to pick a fresh cache instance. */
export function resetNonceCacheForTests(): void {
  cache = undefined;
}

// Slightly longer than signing.ts's own MAX_CLOCK_SKEW_MS (5 minutes) - a
// nonce only needs remembering for as long as its timestamp would still
// pass that check anyway; once it's aged out there, a replay of it would
// already be rejected by the timestamp window alone, nonce or not. The
// small margin just covers clock/processing skew around that boundary.
const NONCE_TTL_MS = 6 * 60 * 1000;

/**
 * Call after a federation request's signature has already verified (never
 * before - no point remembering nonces for forged/invalid requests, and
 * doing so would let an attacker cheaply fill the cache with garbage).
 * The signature itself is the nonce: it's unique per (method, path,
 * timestamp, body) and unforgeable without the origin's private key, so
 * there's nothing else to generate or have the sender supply separately.
 */
export function checkAndRecordNonce(signature: string): Promise<boolean> {
  return getNonceCache().checkAndRecord(signature, NONCE_TTL_MS);
}
