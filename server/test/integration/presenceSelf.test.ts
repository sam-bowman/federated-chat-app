import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebSocketGateway } from "../../src/ws/gateway.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

type Registered = Awaited<ReturnType<typeof registerUser>>;
type Event = { type: string; status?: string; customStatus?: string | null; userId?: string };

beforeEach(resetDb);
afterAll(disconnectDb);

let server: http.Server;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  server = http.createServer();
  createWebSocketGateway(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Opens a connection as this user and collects every event it receives. */
async function connect(user: Registered) {
  const events: Event[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${user.accessToken}`);
  socket.on("message", (data) => events.push(JSON.parse(data.toString())));
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return events;
}

async function until<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for an event");
}

const setPresence = (who: Registered, body: object) =>
  api.patch("/api/v1/users/me/presence").set(authHeader(who.accessToken)).send(body);

const befriend = async (a: Registered, b: Registered) => {
  const sent = await api.post("/api/v1/friends/requests").set(authHeader(a.accessToken)).send({ username: b.user.username });
  await api.post(`/api/v1/friends/requests/${sent.body.request.id}/accept`).set(authHeader(b.accessToken));
};

describe("a person's own devices are told their own status", () => {
  // The bug: the client read its status once, when signing in (before it was connected), so it showed
  // offline while online.
  it("tells you ONLINE when you connect", async () => {
    const alice = await registerUser("alice");

    const events = await connect(alice);

    const own = await until(() => events.find((e) => e.type === "presence:self"));
    expect(own.status).toBe("ONLINE");
  });

  it("tells you a status you set, with your custom status", async () => {
    const alice = await registerUser("alice");
    const events = await connect(alice);
    await until(() => events.find((e) => e.type === "presence:self")); // the one from connecting
    events.length = 0;

    await setPresence(alice, { status: "BUSY" });
    await setPresence(alice, { customStatus: "in a meeting" });

    const busy = await until(() => events.find((e) => e.type === "presence:self" && e.status === "BUSY"));
    expect(busy.customStatus).toBeNull();
    const custom = await until(() => events.find((e) => e.type === "presence:self" && e.customStatus === "in a meeting"));
    expect(custom.status).toBe("BUSY");
  });

  it("tells you INVISIBLE as invisible, while a friend is told you are offline", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await befriend(alice, bob);
    const aliceEvents = await connect(alice);
    const bobEvents = await connect(bob);
    await until(() => aliceEvents.find((e) => e.type === "presence:self"));
    aliceEvents.length = 0;
    bobEvents.length = 0;

    await setPresence(alice, { status: "INVISIBLE" });

    const own = await until(() => aliceEvents.find((e) => e.type === "presence:self"));
    expect(own.status).toBe("INVISIBLE");
    const seenByBob = await until(() => bobEvents.find((e) => e.type === "presence" && e.userId === alice.user.id));
    expect(seenByBob.status).toBe("OFFLINE");
  });

  it("tells every device you have signed in on, so a change on one shows on the others", async () => {
    const alice = await registerUser("alice");
    const phone = await connect(alice);
    const desktop = await connect(alice);
    await until(() => desktop.find((e) => e.type === "presence:self"));
    phone.length = 0;
    desktop.length = 0;

    await setPresence(alice, { status: "AWAY" });

    expect((await until(() => phone.find((e) => e.type === "presence:self" && e.status === "AWAY"))).status).toBe("AWAY");
    expect((await until(() => desktop.find((e) => e.type === "presence:self" && e.status === "AWAY"))).status).toBe("AWAY");
  });

  it("is only for you: a friend gets the ordinary presence event, never your own", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await befriend(alice, bob);
    const bobEvents = await connect(bob);
    await connect(alice);
    await until(() => bobEvents.find((e) => e.type === "presence" && e.userId === alice.user.id)); // alice connected
    bobEvents.length = 0;

    await setPresence(alice, { status: "BUSY" });

    await until(() => bobEvents.find((e) => e.type === "presence" && e.status === "BUSY"));
    expect(bobEvents.some((e) => e.type === "presence:self")).toBe(false);
  });

  it("does not tell someone else's devices", async () => {
    const alice = await registerUser("alice");
    const stranger = await registerUser("stranger");
    const strangerEvents = await connect(stranger);
    await until(() => strangerEvents.find((e) => e.type === "presence:self")); // their own, from connecting
    strangerEvents.length = 0;
    await connect(alice);

    await setPresence(alice, { status: "BUSY" });
    await new Promise((r) => setTimeout(r, 300));

    expect(strangerEvents.filter((e) => e.type === "presence:self" || e.type === "presence")).toEqual([]);
  });
});
