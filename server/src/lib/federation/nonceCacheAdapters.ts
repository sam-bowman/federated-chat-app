import type { Redis } from "ioredis";

export interface NonceCache {
  /**
   * Records `key` as seen, returning true if it was genuinely new (the
   * caller should proceed) or false if it was already present (a replay -
   * the caller should reject). Atomic: two concurrent calls with the same
   * key must never both see "new".
   */
  checkAndRecord(key: string, ttlMs: number): Promise<boolean>;
}

/**
 * Single-process, in-memory nonce store - correct for one replica, but
 * each replica would have its own independent set under more than one
 * (a replay sent to a different replica than the one that saw the
 * original would go uncaught). See RedisNonceCache for that case, and
 * nonceCache.ts's getNonceCache() for which one is actually selected.
 */
export class InMemoryNonceCache implements NonceCache {
  private readonly expiresAt = new Map<string, number>();

  async checkAndRecord(key: string, ttlMs: number): Promise<boolean> {
    this.evictExpired();
    if (this.expiresAt.has(key)) return false;
    this.expiresAt.set(key, Date.now() + ttlMs);
    return true;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, expiry] of this.expiresAt) {
      if (expiry <= now) this.expiresAt.delete(key);
    }
  }
}

/**
 * Redis-backed nonce store, shared across every replica - a single `SET
 * key value NX PX ttlMs` is atomic, so two replicas racing on the same
 * key still only ever get one "new" result between them, the same
 * guarantee the in-memory version gets for free from being single-process.
 */
export class RedisNonceCache implements NonceCache {
  constructor(private readonly client: Redis) {}

  async checkAndRecord(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(`nonce:${key}`, "1", "PX", ttlMs, "NX");
    return result === "OK";
  }
}
