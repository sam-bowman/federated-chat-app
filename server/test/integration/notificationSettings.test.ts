// What a person wants to hear and see when a message arrives: per account, for everything and for one place, and following
// them to every device.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { MAX_SETTINGS_PER_USER } from "../../src/lib/notificationSettings.js";
import { api } from "../helpers/app.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;

const put = (user: Registered, body: unknown) => api.put("/api/v1/notification-settings").set(authHeader(user.accessToken)).send(body as object);
const list = (user: Registered) => api.get("/api/v1/notification-settings").set(authHeader(user.accessToken));

describe("GET /notification-settings", () => {
  it("needs a signed-in person", async () => {
    expect((await api.get("/api/v1/notification-settings")).status).toBe(401);
    expect((await api.put("/api/v1/notification-settings").send({ type: "GLOBAL", sound: false })).status).toBe(401);
  });

  it("is empty until something is chosen: the defaults are not stored", async () => {
    const alice = await registerUser("alice");
    const res = await list(alice);
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual([]);
  });
});

describe("PUT /notification-settings", () => {
  it("sets the global choices, each on its own", async () => {
    const alice = await registerUser("alice");
    const res = await put(alice, { type: "GLOBAL", sound: false });
    expect(res.status).toBe(200);
    expect(res.body.setting).toEqual({ type: "GLOBAL", id: null, sound: false, notify: null });

    const second = await put(alice, { type: "GLOBAL", notify: false });
    expect(second.body.setting).toEqual({ type: "GLOBAL", id: null, sound: false, notify: false });
    expect((await list(alice)).body.settings).toEqual([{ type: "GLOBAL", id: null, sound: false, notify: false }]);
  });

  it("sets a community, a channel and a conversation separately", async () => {
    const alice = await registerUser("alice");
    await put(alice, { type: "COMMUNITY", id: "COMMUNITYID1", sound: false });
    await put(alice, { type: "CHANNEL", id: "CHANNELID1", sound: true, notify: false });
    await put(alice, { type: "CONVERSATION", id: "CONVERSATIONID1", notify: false });

    const settings = (await list(alice)).body.settings as { type: string; id: string | null; sound: boolean | null; notify: boolean | null }[];
    expect(settings).toHaveLength(3);
    expect(settings).toContainEqual({ type: "COMMUNITY", id: "COMMUNITYID1", sound: false, notify: null });
    expect(settings).toContainEqual({ type: "CHANNEL", id: "CHANNELID1", sound: true, notify: false });
    expect(settings).toContainEqual({ type: "CONVERSATION", id: "CONVERSATIONID1", sound: null, notify: false });
  });

  it("keeps the same id apart for different kinds of place", async () => {
    const alice = await registerUser("alice");
    await put(alice, { type: "CHANNEL", id: "SAMEID", sound: false });
    await put(alice, { type: "CONVERSATION", id: "SAMEID", sound: true });
    expect(await prisma.notificationSetting.count()).toBe(2);
  });

  it("takes one choice away with null and forgets the row when none is left", async () => {
    const alice = await registerUser("alice");
    await put(alice, { type: "CHANNEL", id: "CH1", sound: false, notify: false });

    const half = await put(alice, { type: "CHANNEL", id: "CH1", sound: null });
    expect(half.body.setting).toEqual({ type: "CHANNEL", id: "CH1", sound: null, notify: false });
    expect(await prisma.notificationSetting.count()).toBe(1);

    const none = await put(alice, { type: "CHANNEL", id: "CH1", notify: null });
    expect(none.body.setting).toEqual({ type: "CHANNEL", id: "CH1", sound: null, notify: null });
    expect(await prisma.notificationSetting.count()).toBe(0);
    expect((await list(alice)).body.settings).toEqual([]);
  });

  it("is harmless to reset a choice that was never made", async () => {
    const alice = await registerUser("alice");
    const res = await put(alice, { type: "CHANNEL", id: "NEVER", sound: null, notify: null });
    expect(res.status).toBe(200);
    expect(await prisma.notificationSetting.count()).toBe(0);
  });

  it("refuses what makes no sense, and stores nothing", async () => {
    const alice = await registerUser("alice");
    for (const body of [
      {},
      { type: "GLOBAL" },
      { type: "GLOBAL", id: "x", sound: true },
      { type: "CHANNEL", sound: true },
      { type: "CHANNEL", id: "has space", sound: true },
      { type: "CHANNEL", id: "a".repeat(65), sound: true },
      { type: "NOPE", id: "x", sound: true },
      { type: "GLOBAL", sound: "yes" },
      { type: "GLOBAL", sound: true, surprise: 1 },
    ]) {
      const res = await put(alice, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await prisma.notificationSetting.count()).toBe(0);
  });

  it("is each person's own: nobody sees or changes another's", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await put(alice, { type: "GLOBAL", sound: false });
    await put(alice, { type: "CHANNEL", id: "CH1", notify: false });

    expect((await list(bob)).body.settings).toEqual([]);
    await put(bob, { type: "CHANNEL", id: "CH1", notify: true });
    expect((await list(alice)).body.settings).toContainEqual({ type: "CHANNEL", id: "CH1", sound: null, notify: false });
    expect((await list(bob)).body.settings).toEqual([{ type: "CHANNEL", id: "CH1", sound: null, notify: true }]);
  });

  it("stops one account filling the table, but still lets it change what it has", async () => {
    const alice = await registerUser("alice");
    const aliceRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    await prisma.notificationSetting.createMany({
      data: Array.from({ length: MAX_SETTINGS_PER_USER }, (_, i) => ({ userId: aliceRow.id, targetType: "CHANNEL" as const, targetId: `CH${i}`, sound: false })),
    });

    const another = await put(alice, { type: "CHANNEL", id: "ONEMORE", sound: false });
    expect(another.status).toBe(409);
    expect(another.body.error).toBe("too_many_settings");
    expect(await prisma.notificationSetting.count({ where: { userId: aliceRow.id } })).toBe(MAX_SETTINGS_PER_USER);

    // The cap is each account's own: another person is not held back by it.
    const bob = await registerUser("bob");
    expect((await put(bob, { type: "CHANNEL", id: "ONEMORE", sound: false })).status).toBe(200);

    expect((await put(alice, { type: "CHANNEL", id: "CH0", notify: false })).status).toBe(200);
    expect((await put(alice, { type: "CHANNEL", id: "CH1", sound: null })).status).toBe(200);
    expect(await prisma.notificationSetting.count({ where: { userId: aliceRow.id } })).toBe(MAX_SETTINGS_PER_USER - 1);
  });

  it("goes with the account when it is deleted", async () => {
    const alice = await registerUser("alice");
    await put(alice, { type: "GLOBAL", sound: false });
    await prisma.user.delete({ where: { protocolId: alice.user.id } });
    expect(await prisma.notificationSetting.count()).toBe(0);
  });

  it("tells the person's other devices, and nobody else", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await put(alice, { type: "CHANNEL", id: "CH1", sound: false });

    const aliceRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const bobRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: bob.user.id } });
    const events = await prisma.syncEvent.findMany({ where: { type: "notification-settings:updated" } });
    expect(events).toHaveLength(1);
    expect(events[0].recipientId).toBe(aliceRow.id);
    expect(events[0].recipientId).not.toBe(bobRow.id);
    expect(events[0].payload).toEqual({ setting: { type: "CHANNEL", id: "CH1", sound: false, notify: null } });
  });
});
