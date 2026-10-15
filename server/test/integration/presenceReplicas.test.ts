import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Redis-backed, like presenceFanout.test.ts - see the comment there for why this is
// TEST_REDIS_URL and not set globally, and why REDIS_URL is removed again afterwards.
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";

// Imported after REDIS_URL is set: config.ts reads it once, when first loaded.
const { disconnectDb, resetDb } = await import("../helpers/db.js");
const { registerUser } = await import("../helpers/factory.js");
const { prisma } = await import("../../src/db.js");
const { getRedisClients } = await import("../../src/lib/redis.js");
const { startPresenceMaintenance } = await import("../../src/ws/presenceMaintenance.js");
const { closeGatewayConnections, createWebSocketGateway } = await import("../../src/ws/gateway.js");
const { liveConnectionUserIds, markConnectionAlive, markReplicaAlive, markReplicaGone, newConnectionId, otherReplicasAlive } =
  await import("../../src/ws/presenceFanout.js");

const redisOrNull = getRedisClients();
if (!redisOrNull) throw new Error("REDIS_URL must resolve to a real client for the replica presence tests");
const redis = redisOrNull;

async function flushKeys() {
  for (const pattern of ["ws:conn:*", "ws:replica:*"]) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.pub.scan(cursor, "MATCH", pattern, "COUNT", 100);
      if (keys.length) await redis.pub.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  }
}

beforeEach(async () => {
  await resetDb();
  await flushKeys();
});
afterAll(async () => {
  await flushKeys();
  await disconnectDb();
  redis.pub.disconnect();
  redis.sub.disconnect();
  delete process.env.REDIS_URL;
});

const presenceOf = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).presenceStatus;

async function localUser(name: string, presenceStatus: "ONLINE" | "OFFLINE" = "ONLINE") {
  const registered = await registerUser(name);
  const row = await prisma.user.findUniqueOrThrow({ where: { protocolId: registered.user.id } });
  await prisma.user.update({ where: { id: row.id }, data: { presenceStatus } });
  return { ...registered, id: row.id };
}

describe("replica and connection tracking in Redis", () => {
  it("lists every user with a live connection, once each, however many connections they have", async () => {
    await markConnectionAlive("user-a", newConnectionId());
    await markConnectionAlive("user-a", newConnectionId());
    await markConnectionAlive("user-b", newConnectionId());

    expect([...(await liveConnectionUserIds())].sort()).toEqual(["user-a", "user-b"]);
  });

  it("sees another replica, but never itself, and stops seeing it once it is gone", async () => {
    const me = randomUUID();
    const other = randomUUID();
    await markReplicaAlive(me);
    expect(await otherReplicasAlive(me)).toBe(false);

    await markReplicaAlive(other);
    expect(await otherReplicasAlive(me)).toBe(true);

    await markReplicaGone(other);
    expect(await otherReplicasAlive(me)).toBe(false);
  });

  it("gives the replica key a lifetime, so a crashed replica stops counting on its own", async () => {
    const id = randomUUID();
    await markReplicaAlive(id);

    const ttl = await redis.pub.ttl(`ws:replica:${id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(90);
  });
});

describe("clearing stale presence when a replica starts", () => {
  // The bug (#160): restarting one replica showed every user connected to the OTHER replica as
  // offline, and they stayed that way while their sockets were open.
  it("leaves users connected to another running replica ONLINE, and clears only the orphaned ones", async () => {
    const connectedElsewhere = await localUser("connected");
    const orphan = await localUser("orphan");
    const remote = await prisma.user.create({
      data: {
        protocolId: "REMOTEUSERPROTOCOLID",
        username: "far",
        displayName: "Far",
        homeserverDomain: "far.invalid",
        isRemote: true,
        presenceStatus: "ONLINE",
      },
    });
    await markReplicaAlive(randomUUID()); // the replica serving "connected"
    await markConnectionAlive(connectedElsewhere.id, newConnectionId());

    const stop = await startPresenceMaintenance();
    await stop();

    expect(await presenceOf(connectedElsewhere.id)).toBe("ONLINE");
    expect(await presenceOf(orphan.id)).toBe("OFFLINE");
    // Their home server keeps our copy current while other replicas run; not ours to reset.
    expect(await presenceOf(remote.id)).toBe("ONLINE");
  });

  // Unchanged behaviour for the common case, and for the first replica up: with nothing else
  // running, nothing can be connected, so every stored presence is stale.
  it("resets everything, remote users included, when it is the only replica running", async () => {
    const stale = await localUser("stale");
    const remote = await prisma.user.create({
      data: {
        protocolId: "REMOTEUSERPROTOCOLID",
        username: "far",
        displayName: "Far",
        homeserverDomain: "far.invalid",
        isRemote: true,
        presenceStatus: "ONLINE",
      },
    });

    const stop = await startPresenceMaintenance();
    await stop();

    expect(await presenceOf(stale.id)).toBe("OFFLINE");
    expect(await presenceOf(remote.id)).toBe("OFFLINE");
  });

  it("registers itself while running and unregisters on stop", async () => {
    const probe = randomUUID();
    const stop = await startPresenceMaintenance();
    expect(await otherReplicasAlive(probe)).toBe(true); // the running one counts as "another" to the probe

    await stop();
    expect(await otherReplicasAlive(probe)).toBe(false);
  });
});

describe("graceful shutdown of the WebSocket gateway", () => {
  it("closes each client with 1001 (going away) and has presence settled when it returns", async () => {
    const server = http.createServer();
    createWebSocketGateway(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const alice = await registerUser("alice");
      const aliceRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${alice.accessToken}`);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      // Connect handling is asynchronous: wait until the server has marked the user online.
      for (let i = 0; i < 50 && (await presenceOf(aliceRow.id)) !== "ONLINE"; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await presenceOf(aliceRow.id)).toBe("ONLINE");

      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
      );
      await closeGatewayConnections();

      expect(await closed).toEqual({ code: 1001, reason: "server_restarting" });
      expect(await presenceOf(aliceRow.id)).toBe("OFFLINE");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
