import { Redis } from "ioredis";
import { config } from "../config.js";

export interface RedisClients {
  // A dedicated publish connection and a dedicated subscribe connection -
  // ioredis (like Redis itself) doesn't let one connection do both once
  // SUBSCRIBE has been called on it.
  pub: Redis;
  sub: Redis;
}

let clients: RedisClients | null | undefined;

/**
 * Lazily creates (once) and returns this process's Redis pub/sub clients, or
 * null if REDIS_URL isn't set - in which case every caller is expected to
 * fall back to purely local, in-process behavior. Never connects to Redis at
 * module load time, so a single-replica deployment (or the test suite) that
 * never calls this never touches Redis at all.
 */
export function getRedisClients(): RedisClients | null {
  if (clients !== undefined) return clients;

  if (!config.redisUrl) {
    clients = null;
    return null;
  }

  const pub = new Redis(config.redisUrl);
  const sub = new Redis(config.redisUrl);
  pub.on("error", (err: Error) => console.error("[redis] publish connection error:", err));
  sub.on("error", (err: Error) => console.error("[redis] subscribe connection error:", err));

  clients = { pub, sub };
  return clients;
}

/** Test-only: forces the next getRedisClients() call to re-read config. */
export function resetRedisClientsForTests() {
  clients = undefined;
}
