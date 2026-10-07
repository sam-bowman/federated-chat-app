import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Deliberately separate from REDIS_URL (which the rest of the app/test suite
// reads to decide whether Redis-backed fan-out is enabled at all) - this
// lets CI provide a Redis service container for *this file only* without
// quietly changing every other integration test's behavior. Locally this
// defaults to the Redis docker-compose brings up on a non-default port (see
// docker-compose.yml).
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";

const { getRedisClients } = await import("../../src/lib/redis.js");
const { countFleetConnections, markConnectionAlive, markConnectionGone, newConnectionId, publishFanout, subscribeFanout } =
  await import("../../src/ws/presenceFanout.js");

const redisOrNull = getRedisClients();
if (!redisOrNull) {
  throw new Error("REDIS_URL must resolve to a real client for presenceFanout integration tests");
}
const redis = redisOrNull;

async function flushTestKeys() {
  let cursor = "0";
  do {
    const [next, keys] = await redis.pub.scan(cursor, "MATCH", "ws:conn:*", "COUNT", 100);
    if (keys.length) await redis.pub.del(...keys);
    cursor = next;
  } while (cursor !== "0");
}

beforeEach(flushTestKeys);
afterAll(async () => {
  await flushTestKeys();
  redis.pub.disconnect();
  redis.sub.disconnect();
  // Integration test files share one worker process (fileParallelism:
  // false, singleFork: true - see vitest.integration.config.ts) and
  // process.env is genuinely global even though each file gets its own
  // isolated module graph. Without this, setting REDIS_URL above would leak
  // into whichever integration test file happens to run next, silently
  // enabling Redis-backed fan-out for tests that are supposed to be
  // exercising the single-replica (no Redis) code path.
  delete process.env.REDIS_URL;
});

describe("fleet-wide connection tracking", () => {
  it("counts 0 for a user with no tracked connections", async () => {
    expect(await countFleetConnections(`user-${randomUUID()}`)).toBe(0);
  });

  it("counts multiple connections for the same user under different connection ids", async () => {
    const userId = `user-${randomUUID()}`;
    await markConnectionAlive(userId, newConnectionId());
    await markConnectionAlive(userId, newConnectionId());
    expect(await countFleetConnections(userId)).toBe(2);
  });

  it("drops the count as connections are marked gone, reaching 0 only once all are", async () => {
    const userId = `user-${randomUUID()}`;
    const connA = newConnectionId();
    const connB = newConnectionId();
    await markConnectionAlive(userId, connA);
    await markConnectionAlive(userId, connB);

    await markConnectionGone(userId, connA);
    expect(await countFleetConnections(userId)).toBe(1);

    await markConnectionGone(userId, connB);
    expect(await countFleetConnections(userId)).toBe(0);
  });

  it("never confuses two different users' connections", async () => {
    const userA = `user-${randomUUID()}`;
    const userB = `user-${randomUUID()}`;
    await markConnectionAlive(userA, newConnectionId());
    expect(await countFleetConnections(userA)).toBe(1);
    expect(await countFleetConnections(userB)).toBe(0);
  });

  // Regression-relevant: without a TTL, a replica that crashes outright
  // (never fires its WebSocket 'close' handler, so markConnectionGone is
  // never called) would leave that user stuck "online" forever as far as
  // every other replica is concerned.
  it("sets a TTL on a marked connection, so a crashed replica's entries expire on their own", async () => {
    const userId = `user-${randomUUID()}`;
    const connId = newConnectionId();
    await markConnectionAlive(userId, connId);

    const ttl = await redis.pub.ttl(`ws:conn:${userId}:${connId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(90);
  });
});

describe("cross-replica fan-out", () => {
  // This is the architectural point of the whole module: one publish must
  // reach every independent subscriber connection, not just the one that
  // published it - that's the exact mechanism server/src/ws/gateway.ts
  // relies on so a message sent on one replica reaches a user whose live
  // socket happens to be held open on a completely different replica.
  it("delivers one publish to the publisher's own subscription and to a fully independent subscriber connection", async () => {
    const selfReceived: { userIds: string[]; event: unknown }[] = [];
    subscribeFanout((userIds, event) => selfReceived.push({ userIds, event }));

    // A second, independent TCP connection to Redis standing in for another
    // replica's own subscriber - not the app's singleton.
    const otherReplicaSub = new Redis(process.env.REDIS_URL!);
    const otherReceived: unknown[] = [];
    otherReplicaSub.on("message", (_channel: string, message: string) => {
      otherReceived.push(JSON.parse(message));
    });
    await otherReplicaSub.subscribe("ws:fanout");

    // SUBSCRIBE is itself a round-trip to Redis - give both subscriptions a
    // moment to actually register before publishing.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const userId = `user-${randomUUID()}`;
    const published = await publishFanout([userId], { type: "test-event", hello: "world" });
    expect(published).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(selfReceived).toHaveLength(1);
    expect(selfReceived[0]).toEqual({ userIds: [userId], event: { type: "test-event", hello: "world" } });

    expect(otherReceived).toHaveLength(1);
    expect(otherReceived[0]).toEqual({ userIds: [userId], event: { type: "test-event", hello: "world" } });

    otherReplicaSub.disconnect();
  });
});
