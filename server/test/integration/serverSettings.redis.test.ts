// Server settings across replicas (#206, phase 4 follow-up): with Redis, a replica reads the settings table as soon as another one says it changed
// something, instead of at the next timer tick. The tests run in ONE process, so "another replica" is a second Redis connection that publishes
// the same message, and the table is written directly (as the other replica would have).
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redis-backed, like presenceReplicas.test.ts: see presenceFanout.test.ts for why this is TEST_REDIS_URL and not set globally.
const redisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";
process.env.REDIS_URL = redisUrl;

// Imported after REDIS_URL is set: config.ts reads it once, when first loaded.
const { config, settingsEnvironment } = await import("../../src/config.js");
const { prisma } = await import("../../src/db.js");
const { getRedisClients } = await import("../../src/lib/redis.js");
const { SETTING_KEYS } = await import("../../src/lib/serverSettings.js");
const { loadServerSettings, resetSetting, setSetting, startServerSettingsSync } = await import("../../src/modules/settings/service.js");
const { disconnectDb, resetDb } = await import("../helpers/db.js");

const CHANNEL = "settings:changed";
const redisOrNull = getRedisClients();
if (!redisOrNull) throw new Error("REDIS_URL must resolve to a real client for the settings pub/sub tests");
const redis = redisOrNull;
const otherReplica = new Redis(redisUrl);
const listener = new Redis(redisUrl);

const realEnvironment = { ...settingsEnvironment };
// A long interval, so only a message can be what made a replica read: the timer must not be the reason a test passes.
const NEVER = 60 * 60 * 1000;
let stopSync: (() => void) | null = null;

beforeEach(async () => {
  await resetDb();
  for (const key of SETTING_KEYS) settingsEnvironment[key] = undefined;
  await loadServerSettings();
});
afterEach(async () => {
  stopSync?.();
  stopSync = null;
  vi.restoreAllMocks();
  await prisma.serverSetting.deleteMany();
  await loadServerSettings();
  Object.assign(settingsEnvironment, realEnvironment);
  config.serverName = "Test Server";
});
afterAll(async () => {
  await disconnectDb();
  otherReplica.disconnect();
  listener.disconnect();
  redis.pub.disconnect();
  redis.sub.disconnect();
  delete process.env.REDIS_URL;
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
// Subscribing is asynchronous: a message published before the server has the subscription is lost, which is the very thing the timer is for.
async function listening(): Promise<void> {
  stopSync = startServerSettingsSync(NEVER);
  await new Promise((resolve) => setTimeout(resolve, 200));
}

describe("a change made on another replica", () => {
  it("is read as soon as that replica says so, without waiting for the timer", async () => {
    await listening();
    await prisma.serverSetting.create({ data: { key: "SERVER_NAME", value: "Named by another replica" } });
    expect(config.serverName).not.toBe("Named by another replica");

    await otherReplica.publish(CHANNEL, "some-other-replica");

    await until(() => config.serverName === "Named by another replica");
  });

  it("is not seen at all without the message (this is what the timer is for), so the test above proves the message did it", async () => {
    await listening();
    await prisma.serverSetting.create({ data: { key: "SERVER_NAME", value: "Named quietly" } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(config.serverName).not.toBe("Named quietly");
  });

  it("is not read after the replica stopped listening", async () => {
    await listening();
    stopSync?.();
    stopSync = null;
    await prisma.serverSetting.create({ data: { key: "SERVER_NAME", value: "Too late" } });

    await otherReplica.publish(CHANNEL, "some-other-replica");
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(config.serverName).not.toBe("Too late");
  });

  it("leaves no listener behind when it stops (it would otherwise pile up on the shared subscribe connection)", async () => {
    const before = redis.sub.listenerCount("message");
    await listening();
    expect(redis.sub.listenerCount("message")).toBe(before + 1);
    stopSync?.();
    stopSync = null;
    expect(redis.sub.listenerCount("message")).toBe(before);
  });
});

describe("a change made on this replica", () => {
  async function announcements(): Promise<{ seen: string[] }> {
    const seen: string[] = [];
    listener.on("message", (channel: string, message: string) => {
      if (channel === CHANNEL) seen.push(message);
    });
    await listener.subscribe(CHANNEL);
    return { seen };
  }

  it("is announced when a setting is stored and when it is reset, and not when nothing changed", async () => {
    const { seen } = await announcements();

    await setSetting("SERVER_NAME", "Announced");
    await until(() => seen.length === 1);

    await setSetting("SERVER_NAME", "Announced"); // the same value again: nothing changed
    await resetSetting("SERVER_NAME");
    await until(() => seen.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toHaveLength(2);

    await resetSetting("SERVER_NAME"); // nothing stored any more: nothing to tell
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toHaveLength(2);
    listener.removeAllListeners("message");
    await listener.unsubscribe(CHANNEL);
  });

  it("carries no value, only who sent it", async () => {
    const { seen } = await announcements();
    await setSetting("SERVER_NAME", "A name that must not travel");
    await until(() => seen.length === 1);
    expect(seen[0]).not.toContain("must not travel");
    listener.removeAllListeners("message");
    await listener.unsubscribe(CHANNEL);
  });

  it("does not make this replica read the table again for its own announcement", async () => {
    const { seen } = await announcements();
    await listening();
    await setSetting("SERVER_NAME", "Mine");
    await until(() => seen.length === 1);
    const ownId = seen[0];

    const reads = vi.spyOn(prisma.serverSetting, "findMany");
    await otherReplica.publish(CHANNEL, ownId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads).not.toHaveBeenCalled();

    await otherReplica.publish(CHANNEL, "a-different-replica");
    await until(() => reads.mock.calls.length > 0);
    listener.removeAllListeners("message");
    await listener.unsubscribe(CHANNEL);
  });
});

describe("many announcements at once", () => {
  it("do not start a read each: one under way, and one more for everything that arrived meanwhile", async () => {
    await listening();
    const reads = vi.spyOn(prisma.serverSetting, "findMany");

    await Promise.all(Array.from({ length: 30 }, () => otherReplica.publish(CHANNEL, "some-other-replica")));
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(reads.mock.calls.length).toBeLessThan(10);
  });

  it("still end on the newest state: a change announced while a read is under way gets one more read", async () => {
    await listening();
    // The first read takes the table as it is at that moment and then dawdles, so what is stored after it started is not in it.
    const real = prisma.serverSetting.findMany.bind(prisma.serverSetting) as () => Promise<unknown[]>;
    vi.spyOn(prisma.serverSetting, "findMany").mockImplementationOnce((async () => {
      const rows = await real();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return rows;
    }) as never);

    await otherReplica.publish(CHANNEL, "some-other-replica"); // starts the slow read, of a table with nothing in it
    await new Promise((resolve) => setTimeout(resolve, 100));
    await prisma.serverSetting.create({ data: { key: "SERVER_NAME", value: "Stored during a read" } });
    await otherReplica.publish(CHANNEL, "some-other-replica"); // arrives while that read is still under way

    await until(() => config.serverName === "Stored during a read");
  });
});
