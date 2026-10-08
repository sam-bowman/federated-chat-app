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
let rateLimitClient: Redis | null | undefined;

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

/**
 * Lazily creates (once) and returns a Redis connection dedicated to rate
 * limiting (server/src/middleware/rateLimit.ts), or null if REDIS_URL isn't
 * set - same gating as getRedisClients(), but its own separate connection
 * rather than reusing `pub`/`sub`: those two are purpose-dedicated (`sub`
 * specifically can't run ordinary commands once subscribed), not a store a
 * rate limiter should share.
 */
export function getRateLimitRedisClient(): Redis | null {
  if (rateLimitClient !== undefined) return rateLimitClient;

  if (!config.redisUrl) {
    rateLimitClient = null;
    return null;
  }

  const client = new Redis(config.redisUrl);
  client.on("error", (err: Error) => console.error("[redis] rate-limit connection error:", err));

  rateLimitClient = client;
  return rateLimitClient;
}

/** Test-only: forces the next getRedisClients()/getRateLimitRedisClient() call to re-read config. */
export function resetRedisClientsForTests() {
  clients = undefined;
  rateLimitClient = undefined;
}
