// Same reasoning as presenceFanout.test.ts: deliberately separate from
// REDIS_URL/RATE_LIMIT_MAX (which the rest of the suite reads to decide
// whether Redis-backed rate limiting is enabled, and at what threshold) so
// this file can exercise that path without quietly changing every other
// integration test's behavior.
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";
process.env.RATE_LIMIT_MAX = "5";
process.env.AUTH_RATE_LIMIT_MAX = "2";

const { api } = await import("../helpers/app.js");
const { getRateLimitRedisClient, resetRedisClientsForTests } = await import("../../src/lib/redis.js");
const { disconnectDb, resetDb } = await import("../helpers/db.js");

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const redisClientOrNull = getRateLimitRedisClient();
if (!redisClientOrNull) {
  throw new Error("REDIS_URL must resolve to a real client for rateLimit redis integration tests");
}
const redisClient = redisClientOrNull;

async function flushRateLimitKeys() {
  let cursor = "0";
  do {
    const [next, keys] = await redisClient.scan(cursor, "MATCH", "rl:*", "COUNT", 100);
    if (keys.length) await redisClient.del(...keys);
    cursor = next;
  } while (cursor !== "0");
}

beforeEach(async () => {
  await resetDb();
  await flushRateLimitKeys();
});

afterAll(async () => {
  await flushRateLimitKeys();
  redisClient.disconnect();
  resetRedisClientsForTests();
  await disconnectDb();
  delete process.env.REDIS_URL;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.AUTH_RATE_LIMIT_MAX;
});

describe("rate limiting (Redis-backed store, REDIS_URL set)", () => {
  it("enforces the same limits as the in-memory store when backed by Redis", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await api.post("/api/v1/auth/login").send({ username: "nobody", password: "wrong" });
      expect(res.status).toBe(401);
    }
    const blockedByAuth = await api.post("/api/v1/auth/login").send({ username: "nobody", password: "wrong" });
    expect(blockedByAuth.status).toBe(429);

    for (let i = 0; i < 2; i++) {
      const res = await api.get("/api/v1/communities");
      expect(res.status).not.toBe(429);
    }
    const blockedByGeneral = await api.get("/api/v1/communities");
    expect(blockedByGeneral.status).toBe(429);
  });
});
