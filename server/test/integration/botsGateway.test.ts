import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { closeBotSocketsWithoutWorkingToken, closeGatewayConnections, createWebSocketGateway } from "../../src/ws/gateway.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

// What a bot hears over the websocket (#132): only the events of the communities it is in, proved by its token in the Authorization header
// (never the address), and ended when the token stops being good.
beforeEach(resetDb);
afterAll(disconnectDb);

let server: http.Server;
let port: number;
beforeAll(async () => {
  server = http.createServer();
  createWebSocketGateway(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await closeGatewayConnections(200);
  await new Promise((resolve) => server.close(resolve));
});

const open: WebSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.terminate();
});

interface Listener {
  socket: WebSocket;
  events: { type: string; [key: string]: unknown }[];
  closed: Promise<{ code: number; reason: string }>;
}

/** Opens a socket; resolves once the server has accepted it (or closed it). */
function connect(url: string, headers: Record<string, string> = {}): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    open.push(socket);
    const events: Listener["events"] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) => socket.once("close", (code, reason) => res({ code, reason: reason.toString() })));
    socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    socket.once("open", () => resolve({ socket, events, closed }));
    socket.once("error", reject);
  });
}

const wsUrl = () => `ws://127.0.0.1:${port}/ws`;
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const owner = await registerUser("owner");
  const made = await api.post("/api/v1/bots").set(authHeader(owner.accessToken)).send({ username: "helper" });
  const inside = (await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name: "Inside" })).body.community;
  const outside = (await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name: "Outside" })).body.community;
  await api.post(`/api/v1/communities/${inside.id}/bots`).set(authHeader(owner.accessToken)).send({ username: "helper" });
  return { owner, bot: made.body.bot as { id: string }, token: made.body.token as string, inside, outside };
}

describe("a bot on the websocket", () => {
  it("hears its community's events and nobody else's, with the token in the Authorization header", async () => {
    const { owner, token, inside, outside } = await setup();
    const bot = await connect(wsUrl(), { Authorization: `Bot ${token}` });
    await settle();

    await api.post(`/api/v1/channels/${outside.channels[0].id}/messages`).set(authHeader(owner.accessToken)).send({ content: "elsewhere" });
    await api.post(`/api/v1/channels/${inside.channels[0].id}/messages`).set(authHeader(owner.accessToken)).send({ content: "for the bot" });
    await settle();

    const created = bot.events.filter((e) => e.type === "message:created");
    expect(created).toHaveLength(1);
    expect(JSON.stringify(created[0])).toContain("for the bot");
    expect(JSON.stringify(bot.events)).not.toContain("elsewhere");
  });

  it("is refused with a token in the address, a wrong token, or one that is a person's access token", async () => {
    const { owner, token } = await setup();
    const inAddress = await connect(`${wsUrl()}?token=${token}`);
    expect(await inAddress.closed).toMatchObject({ code: 4001 });
    const wrong = await connect(wsUrl(), { Authorization: `Bot mcb_${"A".repeat(43)}` });
    expect(await wrong.closed).toEqual({ code: 4001, reason: "invalid_token" });
    const asPerson = await connect(wsUrl(), { Authorization: `Bot ${owner.accessToken}` });
    expect(await asPerson.closed).toEqual({ code: 4001, reason: "invalid_token" });
    expect(token).toBeTruthy();
  });

  it("shows as online while connected and offline after", async () => {
    const { bot: made, token } = await setup();
    const row = () => prisma.user.findFirstOrThrow({ where: { protocolId: made.id } });
    const bot = await connect(wsUrl(), { Authorization: `Bot ${token}` });
    for (let i = 0; i < 40 && (await row()).presenceStatus !== "ONLINE"; i++) await settle(50);
    expect((await row()).presenceStatus).toBe("ONLINE");
    bot.socket.close();
    await bot.closed;
    for (let i = 0; i < 40 && (await row()).presenceStatus !== "OFFLINE"; i++) await settle(50);
    expect((await row()).presenceStatus).toBe("OFFLINE");
  });

  it("is disconnected at once when its token is regenerated, and again by the next heartbeat check if only the database changed", async () => {
    const { owner, bot: made, token } = await setup();
    const first = await connect(wsUrl(), { Authorization: `Bot ${token}` });
    await settle();
    const regenerated = await api.post(`/api/v1/bots/${made.id}/token`).set(authHeader(owner.accessToken));
    expect(await first.closed).toEqual({ code: 4001, reason: "invalid_token" });

    // Another replica's change is seen through the database, by the heartbeat's check.
    const second = await connect(wsUrl(), { Authorization: `Bot ${regenerated.body.token}` });
    await settle();
    await closeBotSocketsWithoutWorkingToken();
    await settle();
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    await prisma.user.updateMany({ where: { protocolId: made.id }, data: { botTokenHash: null } });
    await closeBotSocketsWithoutWorkingToken();
    expect(await second.closed).toEqual({ code: 4001, reason: "invalid_token" });
  });

  it("is disconnected when the bot is deleted", async () => {
    const { owner, bot: made, token } = await setup();
    const bot = await connect(wsUrl(), { Authorization: `Bot ${token}` });
    await settle();
    await api.delete(`/api/v1/bots/${made.id}`).set(authHeader(owner.accessToken));
    expect(await bot.closed).toMatchObject({ code: 4001 });
  });
});
