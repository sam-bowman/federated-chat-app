// Same reasoning as presenceFanout.test.ts / rateLimit.redis.test.ts:
// deliberately separate from REDIS_URL (which the rest of the suite reads
// to decide whether Redis-backed replay protection is enabled) so this
// file can exercise that path without quietly changing every other
// integration test's behavior.
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";

const { api } = await import("../helpers/app.js");
const { getNonceRedisClient, resetRedisClientsForTests } = await import("../../src/lib/redis.js");
const { checkAndRecordNonce, resetNonceCacheForTests } = await import("../../src/lib/federation/nonceCache.js");
const { signRequest } = await import("../../src/lib/federation/signing.js");
const { disconnectDb, resetDb } = await import("../helpers/db.js");
const { registerTestPeer } = await import("../helpers/federation.js");
const { registerUser } = await import("../helpers/factory.js");

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const redisClientOrNull = getNonceRedisClient();
if (!redisClientOrNull) {
  throw new Error("REDIS_URL must resolve to a real client for federation replay redis integration tests");
}
const redisClient = redisClientOrNull;

async function flushNonceKeys() {
  let cursor = "0";
  do {
    const [next, keys] = await redisClient.scan(cursor, "MATCH", "nonce:*", "COUNT", 100);
    if (keys.length) await redisClient.del(...keys);
    cursor = next;
  } while (cursor !== "0");
}

beforeEach(async () => {
  await resetDb();
  await flushNonceKeys();
  resetNonceCacheForTests();
});

afterAll(async () => {
  await flushNonceKeys();
  redisClient.disconnect();
  resetRedisClientsForTests();
  resetNonceCacheForTests();
  await disconnectDb();
  delete process.env.REDIS_URL;
});

describe("federation replay protection (Redis-backed store, REDIS_URL set)", () => {
  it("checkAndRecordNonce enforces the same first-seen-wins semantics as the in-memory store", async () => {
    expect(await checkAndRecordNonce("sig-a")).toBe(true);
    expect(await checkAndRecordNonce("sig-a")).toBe(false);
    expect(await checkAndRecordNonce("sig-b")).toBe(true);
  });

  it("two replicas (simulated: two independent Redis-backed checks) never both accept the same replay", async () => {
    const results = await Promise.all([checkAndRecordNonce("sig-race"), checkAndRecordNonce("sig-race")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rejects a real replayed federation request end to end, same as the in-memory path", async () => {
    await registerUser("bob");
    const peer = await registerTestPeer("alice.test");
    const { timestamp, signature } = signRequest(peer.privateKey, "GET", "/federation/v1/users/bob", "");

    const send = () =>
      api
        .get("/federation/v1/users/bob")
        .set("X-Federation-Origin", peer.domain)
        .set("X-Federation-Timestamp", timestamp)
        .set("X-Federation-Signature", signature);

    expect((await send()).status).toBe(200);
    const replay = await send();
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("replayed_federation_request");
  });
});
