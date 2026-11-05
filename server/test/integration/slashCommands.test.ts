// Slash commands (#132, phase 3b, docs/commands-3b-plan.md), end to end against a real database and real websockets: a bot registers its set, a
// member runs a command with options checked against the registered types, the bot is sent a live-only interaction and answers it (a message, a
// private reply, or "thinking" then one follow-up) inside the rules about who, how often, and how long.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { Permission } from "../../src/lib/permissions.js";
import { INTERACTION_LIMITS, pruneInteractions } from "../../src/modules/commands/service.js";
import { purgeAccount } from "../../src/modules/users/deletion.js";
import { closeGatewayConnections, createWebSocketGateway } from "../../src/ws/gateway.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
const as = (user: Registered) => authHeader(user.accessToken);
const botsConfig = config as { botsEnabled: boolean };
const limits = INTERACTION_LIMITS as { pendingPerBot: number };

// --- real sockets
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
  of: (type: string) => { type: string; [key: string]: unknown }[];
}
function connect(headers: Record<string, string> = {}, query = ""): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers });
    open.push(socket);
    const events: Listener["events"] = [];
    socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    socket.once("open", () => resolve({ socket, events, of: (type) => events.filter((e) => e.type === type) }));
    socket.once("error", reject);
  });
}
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await settle(25);
  }
  throw new Error("timed out");
}

// --- setup
const REQUEST = {
  name: "request",
  description: "Ask for a film",
  options: [
    { name: "title", description: "What to look for", type: "string", required: true },
    { name: "kind", description: "Film or show", type: "string", choices: [{ name: "Film", value: "film" }, { name: "Show", value: "show" }] },
    { name: "count", description: "How many", type: "integer" },
    { name: "who", description: "For whom", type: "member" },
    { name: "where", description: "Where to post", type: "channel" },
  ],
};

async function makeBot(owner: Registered, username: string) {
  const made = await api.post("/api/v1/bots").set(as(owner)).send({ username, displayName: username });
  expect(made.status).toBe(201);
  return { header: { Authorization: `Bot ${made.body.token}` }, token: made.body.token as string, id: made.body.bot.id as string, username };
}
type Bot = Awaited<ReturnType<typeof makeBot>>;

const register = (bot: Bot, commands: unknown[]) => api.put("/api/v1/commands").set(bot.header).send({ commands });

async function setup(options: { online?: boolean } = {}) {
  const owner = await registerUser("owner");
  const reader = await registerUser("reader");
  const community = (await api.post("/api/v1/communities").set(as(owner)).send({ name: "Club" })).body.community as { id: string; channels: { id: string }[] };
  await api.post(`/api/v1/communities/${community.id}/members`).set(as(reader));
  const bot = await makeBot(owner, "robo");
  expect((await api.post(`/api/v1/communities/${community.id}/bots`).set(as(owner)).send({ username: "robo" })).status).toBe(201);
  const registered = await register(bot, [REQUEST, { name: "ping", description: "Pong" }]);
  expect(registered.status).toBe(200);
  const socket = options.online === false ? null : await connect(bot.header);
  await settle(50);
  const commandId = (registered.body.commands as { id: string; name: string }[]).find((c) => c.name === "request")!.id;
  const pingId = (registered.body.commands as { id: string; name: string }[]).find((c) => c.name === "ping")!.id;
  return { owner, reader, community, channelId: community.channels[0].id, bot, socket, commandId, pingId };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const run = (s: Setup, user: Registered, options: unknown = { title: "Dune" }, commandId = s.commandId, channelId = s.channelId) =>
  api.post(`/api/v1/channels/${channelId}/commands/${commandId}`).set(as(user)).send({ options });
const callback = (bot: Bot, id: string, body: unknown) => api.post(`/api/v1/interactions/${id}/callback`).set(bot.header).send(body as object);
const followup = (bot: Bot, id: string, body: unknown) => api.post(`/api/v1/interactions/${id}/followup`).set(bot.header).send(body as object);
const stateOf = async (id: string) => (await prisma.interaction.findUniqueOrThrow({ where: { protocolId: id } })).state;
const messages = async (s: Setup) => (await api.get(`/api/v1/channels/${s.channelId}/messages`).set(as(s.reader))).body.messages as { id: string; content: string | null; sender: { username: string }; richEmbeds: unknown[]; interaction: { id: string; command: string; user: { id: string; name: string } } | null }[];

/** Takes a permission away from (or gives one back to) the community's @everyone role. */
async function setEveryone(s: Setup, permissions: bigint) {
  const role = await prisma.role.findFirstOrThrow({ where: { community: { protocolId: s.community.id }, isDefault: true } });
  await prisma.role.update({ where: { id: role.id }, data: { permissions } });
}
const EVERYONE_DEFAULT = Permission.SEND_MESSAGES | Permission.REACT | Permission.CREATE_INVITE | Permission.CONNECT_VOICE | Permission.USE_COMMANDS;

describe("registering commands", () => {
  it("replaces the bot's whole set, in order, and gives each command an id; the bot can read it back", async () => {
    const s = await setup();
    const read = await api.get("/api/v1/commands").set(s.bot.header);
    expect(read.status).toBe(200);
    expect(read.body.commands.map((c: { name: string }) => c.name)).toEqual(["request", "ping"]);
    expect(read.body.commands[0]).toMatchObject({ id: s.commandId, name: "request", description: "Ask for a film" });
    expect(read.body.commands[0].options.map((o: { name: string; required: boolean }) => [o.name, o.required])).toEqual([["title", true], ["kind", false], ["count", false], ["who", false], ["where", false]]);
  });

  it("keeps a command's id when it keeps its name, updates it, removes what was left out, and gives a new command a new id", async () => {
    const s = await setup();
    const again = await register(s.bot, [{ name: "request", description: "Changed", options: [] }, { name: "fresh", description: "New" }]);
    expect(again.status).toBe(200);
    const byName = Object.fromEntries(again.body.commands.map((c: { name: string; id: string; description: string }) => [c.name, c]));
    expect(byName.request.id).toBe(s.commandId);
    expect(byName.request.description).toBe("Changed");
    expect(byName.request.options).toEqual([]);
    expect(byName.fresh.id).not.toBe(s.pingId);
    expect(byName.ping).toBeUndefined();
    expect(await prisma.botCommand.count()).toBe(2);
  });

  it.each([
    ["a name that is not allowed", [{ name: "Bad Name", description: "d" }], /a command's name/],
    ["the same name twice", [{ name: "a", description: "d" }, { name: "a", description: "d" }], /two commands have this name/],
    ["no description", [{ name: "a", description: "" }], /description must not be empty/],
    ["an option of an unknown type", [{ name: "a", description: "d", options: [{ name: "o", description: "d", type: "colour" }] }], /the type must be one of/],
    ["a required option after an optional one", [{ name: "a", description: "d", options: [{ name: "o", description: "d", type: "string" }, { name: "p", description: "d", type: "string", required: true }] }], /required options must come before/],
    ["choices on a boolean", [{ name: "a", description: "d", options: [{ name: "o", description: "d", type: "boolean", choices: [{ name: "x", value: "y" }] }] }], /only string, integer and number options may have choices/],
    ["a name that starts with a symbol", [{ name: "_hidden", description: "d" }], /a command's name/],
  ])("refuses %s, naming it, and changes nothing", async (_name, commands, detail) => {
    const s = await setup();
    const res = await register(s.bot, commands);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_commands");
    expect(res.body.detail).toMatch(detail);
    expect(await prisma.botCommand.count()).toBe(2); // the set it had is untouched
  });

  it("is refused 51 commands, and a body that is not a set", async () => {
    const s = await setup();
    expect((await register(s.bot, Array.from({ length: 51 }, (_, i) => ({ name: `c${i}`, description: "d" })))).status).toBe(400);
    expect((await api.put("/api/v1/commands").set(s.bot.header).send({})).status).toBe(400);
    expect((await api.put("/api/v1/commands").set(s.bot.header).send({ commands: "x" })).status).toBe(400);
  });

  it("is for bots: no header is missing_token, a person's token and a wrong bot token are invalid", async () => {
    const s = await setup();
    expect((await api.put("/api/v1/commands").send({ commands: [] })).body.error).toBe("missing_token");
    expect((await api.put("/api/v1/commands").set(as(s.owner)).send({ commands: [] })).body.error).toBe("invalid_token");
    expect((await api.put("/api/v1/commands").set({ Authorization: `Bot mcb_${"a".repeat(43)}` }).send({ commands: [] })).status).toBe(401);
    expect((await api.get("/api/v1/commands").set(as(s.owner))).status).toBe(401);
  });

  it("never touches another bot's commands", async () => {
    const s = await setup();
    const other = await makeBot(s.owner, "other");
    await register(other, [{ name: "request", description: "Theirs" }]);
    await register(s.bot, [{ name: "ping", description: "Mine only" }]);
    const theirs = await api.get("/api/v1/commands").set(other.header);
    expect(theirs.body.commands).toEqual([expect.objectContaining({ name: "request", description: "Theirs" })]);
  });

  it("tells the members of the communities the bot is in, live, and nobody else", async () => {
    const s = await setup();
    const reader = await connect({}, `?token=${s.reader.accessToken}`);
    const stranger = await registerUser("stranger");
    const outsider = await connect({}, `?token=${stranger.accessToken}`);
    await settle(50);
    await register(s.bot, [{ name: "ping", description: "Pong" }]);
    await until(() => reader.of("commands:updated")[0]);
    expect(reader.of("commands:updated")[0]).toMatchObject({ botId: s.bot.id });
    await settle(100);
    expect(outsider.of("commands:updated")).toHaveLength(0);
    // It is live only: nothing in the sync log.
    expect(await prisma.syncEvent.count({ where: { type: "commands:updated" } })).toBe(0);
  });

  it("goes with the bot when it is deleted", async () => {
    const s = await setup();
    expect((await api.delete(`/api/v1/bots/${s.bot.id}`).set(as(s.owner))).status).toBe(204);
    expect(await prisma.botCommand.count()).toBe(0);
  });
});

describe("what a member may run in a community", () => {
  const listFor = (s: Setup, user: Registered) => api.get(`/api/v1/communities/${s.community.id}/commands`).set(as(user));

  it("lists the commands of the bots in the community, with the bot and whether it is connected, and says the member may use them", async () => {
    const s = await setup();
    const res = await listFor(s, s.reader);
    expect(res.status).toBe(200);
    expect(res.body.canUse).toBe(true);
    expect(res.body.commands.map((c: { name: string }) => c.name)).toEqual(["request", "ping"]);
    expect(res.body.commands[0]).toMatchObject({ id: s.commandId, bot: { username: "robo", isBot: true }, botOnline: true });
  });

  it("says a bot with no socket is offline", async () => {
    const s = await setup({ online: false });
    expect((await listFor(s, s.reader)).body.commands.every((c: { botOnline: boolean }) => c.botOnline === false)).toBe(true);
  });

  it("offers only the commands of bots that are IN this community", async () => {
    const s = await setup();
    const outside = await makeBot(s.owner, "outside");
    await register(outside, [{ name: "secret", description: "Not here" }]);
    const names = (await listFor(s, s.reader)).body.commands.map((c: { name: string }) => c.name);
    expect(names).toEqual(["request", "ping"]);
    await api.delete(`/api/v1/communities/${s.community.id}/members/${s.bot.id}`).set(as(s.owner));
    expect((await listFor(s, s.reader)).body.commands).toEqual([]);
  });

  it("shows two bots with the same command name, told apart by the bot", async () => {
    const s = await setup();
    const other = await makeBot(s.owner, "other");
    await api.post(`/api/v1/communities/${s.community.id}/bots`).set(as(s.owner)).send({ username: "other" });
    await register(other, [{ name: "ping", description: "Their pong" }]);
    const pings = (await listFor(s, s.reader)).body.commands.filter((c: { name: string }) => c.name === "ping");
    expect(pings.map((c: { bot: { username: string } }) => c.bot.username).sort()).toEqual(["other", "robo"]);
    expect(new Set(pings.map((c: { id: string }) => c.id)).size).toBe(2);
  });

  it("does not offer a suspended bot's commands", async () => {
    const s = await setup();
    await prisma.user.update({ where: { protocolId: s.bot.id }, data: { suspendedAt: new Date() } });
    expect((await listFor(s, s.reader)).body.commands).toEqual([]);
  });

  it("says canUse for someone who holds both USE_COMMANDS and SEND_MESSAGES, and no to anyone missing either", async () => {
    const s = await setup();
    await setEveryone(s, EVERYONE_DEFAULT & ~Permission.USE_COMMANDS);
    expect((await listFor(s, s.reader)).body.canUse).toBe(false);
    await setEveryone(s, EVERYONE_DEFAULT & ~Permission.SEND_MESSAGES);
    expect((await listFor(s, s.reader)).body.canUse).toBe(false);
    await setEveryone(s, EVERYONE_DEFAULT);
    expect((await listFor(s, s.reader)).body.canUse).toBe(true);
    expect((await listFor(s, s.owner)).body.canUse).toBe(true);
  });

  it("is for members only: a stranger is told it is not there, and no token is not allowed in", async () => {
    const s = await setup();
    const stranger = await registerUser("stranger");
    expect((await listFor(s, stranger)).status).toBe(404);
    expect((await api.get(`/api/v1/communities/${s.community.id}/commands`)).status).toBe(401);
    expect((await api.get(`/api/v1/communities/${s.community.id}/commands`).set(s.bot.header)).status).toBe(401);
  });

  it("is empty for a community this server only caches, and for everyone while bots are switched off", async () => {
    const s = await setup();
    botsConfig.botsEnabled = false;
    try {
      expect((await listFor(s, s.reader)).body.commands).toEqual([]);
    } finally {
      botsConfig.botsEnabled = true;
    }
    await prisma.community.updateMany({ data: { isRemote: true } });
    expect((await listFor(s, s.reader)).body).toEqual({ commands: [], canUse: false });
  });
});

describe("running a command", () => {
  it("sends the bot exactly one live interaction with the typed options, who ran it and what the options name, and answers 202", async () => {
    const s = await setup();
    const other = await makeBot(s.owner, "other");
    await api.post(`/api/v1/communities/${s.community.id}/bots`).set(as(s.owner)).send({ username: "other" });
    await register(other, [REQUEST]);
    const otherSocket = await connect(other.header);
    const extra = (await api.post(`/api/v1/communities/${s.community.id}/channels`).set(as(s.owner)).send({ name: "alerts" })).body.channel as { id: string };
    await settle(50);

    const res = await run(s, s.reader, { title: "  Dune  ", kind: "film", count: 2, who: s.owner.user.id, where: extra.id });
    expect(res.status).toBe(202);
    const event = await until(() => s.socket!.of("interaction:created")[0]);
    const i = event.interaction as Record<string, unknown>;
    expect(i).toMatchObject({
      id: res.body.interaction.id,
      type: "command",
      command: { id: s.commandId, name: "request" },
      options: { title: "Dune", kind: "film", count: 2, who: s.owner.user.id, where: extra.id },
      channelId: s.channelId,
      communityId: s.community.id,
      user: { id: s.reader.user.id, username: "reader" },
    });
    expect((i.resolved as { members: Record<string, { username: string }> }).members[s.owner.user.id].username).toBe("owner");
    expect((i.resolved as { channels: Record<string, { name: string }> }).channels[extra.id].name).toBe("alerts");
    // Another bot with a command of the same name is not told.
    await settle(100);
    expect(otherSocket.of("interaction:created")).toHaveLength(0);
    expect(s.socket!.of("interaction:created")).toHaveLength(1);
    expect(await stateOf(res.body.interaction.id)).toBe("RECEIVED");
  });

  it("is live only: nothing in the sync log, so a bot that reconnects is not handed an old one", async () => {
    const s = await setup();
    await run(s, s.reader);
    await until(() => s.socket!.of("interaction:created")[0]);
    expect(await prisma.syncEvent.count({ where: { type: "interaction:created" } })).toBe(0);
    const later = await connect(s.bot.header);
    await settle(150);
    expect(later.of("interaction:created")).toHaveLength(0);
  });

  it("takes a command with no options, and options left out", async () => {
    const s = await setup();
    expect((await run(s, s.reader, null, s.pingId)).status).toBe(202);
    expect((await api.post(`/api/v1/channels/${s.channelId}/commands/${s.pingId}`).set(as(s.reader)).send({})).status).toBe(202); // no options key at all
    expect((await run(s, s.reader, { title: "Dune" })).status).toBe(202);
  });

  it.each([
    ["a required option left out", {}, "title"],
    ["an option that does not exist", { title: "t", surprise: 1 }, "surprise"],
    ["a number that is not whole", { title: "t", count: 1.5 }, "count"],
    ["a choice that is not offered", { title: "t", kind: "documentary" }, "kind"],
    ["a text that is not text", { title: 5 }, "title"],
    ["an id that is not well formed", { title: "t", who: "../x" }, "who"],
  ])("refuses %s before the bot hears of it, naming the option", async (_name, options, option) => {
    const s = await setup();
    const res = await run(s, s.reader, options);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_options", option });
    await settle(100);
    expect(s.socket!.of("interaction:created")).toHaveLength(0);
    expect(await prisma.interaction.count()).toBe(0);
  });

  it("holds a member option to the community's members, and a channel option to its text channels", async () => {
    const s = await setup();
    const stranger = await registerUser("stranger");
    const voice = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: (await prisma.community.findFirstOrThrow({ where: { protocolId: s.community.id } })).id, name: "talk", type: "VOICE", position: 5 } });
    const elsewhere = (await api.post("/api/v1/communities").set(as(s.owner)).send({ name: "Elsewhere" })).body.community as { channels: { id: string }[] };
    expect((await run(s, s.reader, { title: "t", who: stranger.user.id })).body).toEqual({ error: "invalid_options", option: "who" });
    expect((await run(s, s.reader, { title: "t", where: voice.protocolId })).body).toEqual({ error: "invalid_options", option: "where" });
    expect((await run(s, s.reader, { title: "t", where: elsewhere.channels[0].id })).body).toEqual({ error: "invalid_options", option: "where" });
    expect((await run(s, s.reader, { title: "t", who: s.reader.user.id })).status).toBe(202); // a member, even themselves
  });

  it("needs USE_COMMANDS and SEND_MESSAGES, each; the owner always may", async () => {
    const s = await setup();
    await setEveryone(s, EVERYONE_DEFAULT & ~Permission.USE_COMMANDS);
    expect((await run(s, s.reader)).status).toBe(403);
    await setEveryone(s, EVERYONE_DEFAULT & ~Permission.SEND_MESSAGES);
    expect((await run(s, s.reader)).status).toBe(403);
    expect((await run(s, s.owner)).status).toBe(202);
    await setEveryone(s, EVERYONE_DEFAULT);
    expect((await run(s, s.reader)).status).toBe(202);
  });

  it("is one 404 for everything it should not reveal: a non-member, a command that does not exist, one of a bot that is not in the community", async () => {
    const s = await setup();
    const stranger = await registerUser("stranger");
    const outside = await makeBot(s.owner, "outside");
    const registered = await register(outside, [{ name: "secret", description: "d" }]);
    const outsideId = registered.body.commands[0].id as string;
    const answers = [await run(s, stranger), await run(s, s.reader, { title: "t" }, "nosuchid"), await run(s, s.reader, { title: "t" }, outsideId), await run(s, s.reader, { title: "t" }, s.commandId, "nosuchchannel")];
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    }
  });

  it("is not for a voice channel, a community this server only caches, a bot's own token, or no token", async () => {
    const s = await setup();
    const row = await prisma.community.findFirstOrThrow({ where: { protocolId: s.community.id } });
    const voice = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: row.id, name: "talk", type: "VOICE", position: 5 } });
    expect((await run(s, s.reader, { title: "t" }, s.commandId, voice.protocolId)).body.error).toBe("not_a_text_channel");
    expect((await api.post(`/api/v1/channels/${s.channelId}/commands/${s.commandId}`).set(s.bot.header).send({ options: { title: "t" } })).status).toBe(401);
    expect((await api.post(`/api/v1/channels/${s.channelId}/commands/${s.commandId}`).send({})).status).toBe(401);
    await prisma.community.updateMany({ data: { isRemote: true } });
    expect((await run(s, s.reader, { title: "t" })).body.error).toBe("not_community_home");
  });

  it("is refused at once, and writes nothing, when the bot has no socket", async () => {
    const s = await setup({ online: false });
    const res = await run(s, s.reader);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("bot_offline");
    expect(await prisma.interaction.count()).toBe(0);
  });

  it("is refused while bots are switched off", async () => {
    const s = await setup();
    botsConfig.botsEnabled = false;
    try {
      expect((await run(s, s.reader)).status).toBe(404);
    } finally {
      botsConfig.botsEnabled = true;
    }
  });

  it("stops sending a bot more while it is too busy to answer what it has", async () => {
    const s = await setup();
    const before = limits.pendingPerBot;
    limits.pendingPerBot = 2;
    try {
      expect((await run(s, s.reader)).status).toBe(202);
      expect((await run(s, s.reader)).status).toBe(202);
      const third = await run(s, s.reader);
      expect(third.status).toBe(429);
      expect(third.body.error).toBe("bot_busy");
      // One answered frees a place; an expired one does not count.
      const first = (await prisma.interaction.findMany({ orderBy: { createdAt: "asc" } }))[0];
      await callback(s.bot, first.protocolId, { type: "ephemeral", content: "ok" });
      expect((await run(s, s.reader)).status).toBe(202);
    } finally {
      limits.pendingPerBot = before;
    }
  });

  it("limits how often one person may run commands, whoever they ask", async () => {
    const s = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < config.commandRateLimitMax + 5; i++) statuses.push((await run(s, s.reader, { title: "t" }, "nosuchid")).status);
    expect(statuses).toContain(429);
    // Another person is not held to it.
    expect((await run(s, s.owner)).status).toBe(202);
  });
});

describe("answering", () => {
  async function ran(s: Setup, options: unknown = { title: "Dune" }) {
    const res = await run(s, s.reader, options);
    expect(res.status).toBe(202);
    return res.body.interaction.id as string;
  }

  it("a message reply is an ordinary message from the bot, marked with who ran which command, and the interaction is done", async () => {
    const s = await setup();
    const reader = await connect({}, `?token=${s.reader.accessToken}`);
    const id = await ran(s);
    const answered = await callback(s.bot, id, { type: "message", content: "Found it.", embeds: [{ title: "Dune", description: "A film" }] });
    expect(answered.status).toBe(201);
    const [message] = await messages(s);
    expect(message).toMatchObject({ id: answered.body.message.id, content: "Found it.", sender: { username: "robo" }, interaction: { id, command: "request", user: { id: s.reader.user.id, name: "reader" } } });
    expect(message.richEmbeds).toEqual([expect.objectContaining({ title: "Dune" })]);
    await until(() => reader.of("message:created")[0]);
    expect(await stateOf(id)).toBe("DONE");
    // Once.
    const again = await callback(s.bot, id, { type: "message", content: "Again" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_answered");
    expect(await prisma.message.count()).toBe(1);
  });

  it("a reply may be only a card, and needs text or a card", async () => {
    const s = await setup();
    const id = await ran(s);
    expect((await callback(s.bot, id, { type: "message" })).status).toBe(400);
    expect((await callback(s.bot, id, { type: "message", content: "" })).status).toBe(400);
    expect((await callback(s.bot, id, { type: "message", embeds: [{ url: "https://example.com" }] })).body.error).toBe("invalid_embeds");
    expect(await stateOf(id)).toBe("RECEIVED"); // refusals do not use the interaction up
    expect((await callback(s.bot, id, { type: "message", embeds: [{ title: "Only a card" }] })).status).toBe(201);
    expect((await messages(s))[0]).toMatchObject({ content: "" });
  });

  it("a private reply reaches the person who ran the command alone, is never stored, and is gone on reload", async () => {
    const s = await setup();
    const reader = await connect({}, `?token=${s.reader.accessToken}`);
    const owner = await connect({}, `?token=${s.owner.accessToken}`);
    await settle(50);
    const id = await ran(s);
    const answered = await callback(s.bot, id, { type: "ephemeral", content: "Only for you", embeds: [{ title: "Private card", image: "https://example.com/a.png" }] });
    expect(answered.status).toBe(204);
    const event = await until(() => reader.of("interaction:response")[0]);
    expect(event).toMatchObject({ interactionId: id, commandName: "request", content: "Only for you", channelId: s.channelId, bot: { username: "robo", isBot: true } });
    expect((event.richEmbeds as { title: string; image?: unknown }[])[0]).toMatchObject({ title: "Private card" });
    expect((event.richEmbeds as { image?: unknown }[])[0].image).toBeUndefined(); // a card nobody keeps has no picture
    await settle(100);
    expect(owner.of("interaction:response")).toHaveLength(0);
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.syncEvent.count({ where: { type: "interaction:response" } })).toBe(0);
    expect(await stateOf(id)).toBe("DONE");
  });

  it("'thinking' tells the person, and one follow-up finishes it as a message", async () => {
    const s = await setup();
    const reader = await connect({}, `?token=${s.reader.accessToken}`);
    await settle(50);
    const id = await ran(s);
    expect((await callback(s.bot, id, { type: "deferred" })).status).toBe(204);
    const update = await until(() => reader.of("interaction:update")[0]);
    expect(update).toMatchObject({ interactionId: id, state: "deferred", commandName: "request" });
    expect(await stateOf(id)).toBe("DEFERRED");

    const finished = await followup(s.bot, id, { content: "Here it is" });
    expect(finished.status).toBe(201);
    expect((await messages(s))[0]).toMatchObject({ content: "Here it is", interaction: expect.objectContaining({ id }) });
    expect(await stateOf(id)).toBe("DONE");
    expect((await followup(s.bot, id, { content: "twice" })).body.error).toBe("already_answered");
    expect((await callback(s.bot, id, { type: "message", content: "late" })).body.error).toBe("already_answered");
  });

  it("a deferred private reply is finished privately", async () => {
    const s = await setup();
    const reader = await connect({}, `?token=${s.reader.accessToken}`);
    await settle(50);
    const id = await ran(s);
    await callback(s.bot, id, { type: "deferred", ephemeral: true });
    const finished = await followup(s.bot, id, { content: "Quietly" });
    expect(finished.status).toBe(204);
    expect((await until(() => reader.of("interaction:response")[0])).content).toBe("Quietly");
    expect(await prisma.message.count()).toBe(0);
  });

  it("a follow-up needs a deferral, text or a card, and comes within 15 minutes", async () => {
    const s = await setup();
    const id = await ran(s);
    expect((await followup(s.bot, id, { content: "too soon" })).body.error).toBe("not_deferred");
    await callback(s.bot, id, { type: "deferred" });
    expect((await followup(s.bot, id, {})).status).toBe(400);
    expect(await stateOf(id)).toBe("DEFERRED");
    await prisma.interaction.update({ where: { protocolId: id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const late = await followup(s.bot, id, { content: "late" });
    expect(late.status).toBe(410);
    expect(late.body.error).toBe("interaction_expired");
    expect(await prisma.message.count()).toBe(0);
  });

  it("holds the FIRST answer to a short window, and refuses a late one without using the interaction up", async () => {
    const s = await setup();
    const late = await ran(s);
    await prisma.interaction.update({ where: { protocolId: late }, data: { createdAt: new Date(Date.now() - (INTERACTION_LIMITS.firstAnswerMs + 1000)) } });
    const refused = await callback(s.bot, late, { type: "message", content: "too slow" });
    expect(refused.status).toBe(410);
    expect(refused.body.error).toBe("interaction_expired");
    expect(await stateOf(late)).toBe("RECEIVED");
    expect(await prisma.message.count()).toBe(0);
    // A deferral is a first answer too.
    expect((await callback(s.bot, late, { type: "deferred" })).status).toBe(410);

    const inTime = await ran(s);
    await prisma.interaction.update({ where: { protocolId: inTime }, data: { createdAt: new Date(Date.now() - (INTERACTION_LIMITS.firstAnswerMs - 2000)) } });
    expect((await callback(s.bot, inTime, { type: "message", content: "just in time" })).status).toBe(201);
  });

  it("is a 404 for an interaction that is not this bot's, or does not exist, and a person's token is not a bot's", async () => {
    const s = await setup();
    const id = await ran(s);
    const other = await makeBot(s.owner, "other");
    for (const res of [await callback(other, id, { type: "ephemeral", content: "x" }), await callback(s.bot, "nosuchid", { type: "ephemeral", content: "x" }), await followup(other, id, { content: "x" })]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    }
    expect((await api.post(`/api/v1/interactions/${id}/callback`).set(as(s.owner)).send({ type: "ephemeral", content: "x" })).status).toBe(401);
    expect((await api.post(`/api/v1/interactions/${id}/callback`).send({ type: "ephemeral", content: "x" })).status).toBe(401);
    expect(await stateOf(id)).toBe("RECEIVED");
  });

  it("refuses a body that is not an answer", async () => {
    const s = await setup();
    const id = await ran(s);
    for (const body of [{}, { type: "shout" }, { type: "deferred", ephemeral: "yes" }, { type: "message", content: 5 }, { type: "message", content: "x".repeat(8001) }]) {
      expect((await callback(s.bot, id, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(await stateOf(id)).toBe("RECEIVED");
  });

  it("needs the bot to hold SEND_MESSAGES for a visible reply, and to still be a member; a private reply needs neither", async () => {
    const s = await setup();
    const id = await ran(s);
    await setEveryone(s, EVERYONE_DEFAULT & ~Permission.SEND_MESSAGES);
    const refused = await callback(s.bot, id, { type: "message", content: "hello" });
    expect(refused.status).toBe(403);
    expect(await stateOf(id)).toBe("RECEIVED"); // not used up: it may still answer privately
    expect((await callback(s.bot, id, { type: "ephemeral", content: "I may not speak here" })).status).toBe(204);

    await setEveryone(s, EVERYONE_DEFAULT);
    const second = await ran(s);
    await api.delete(`/api/v1/communities/${s.community.id}/members/${s.bot.id}`).set(as(s.owner));
    expect((await callback(s.bot, second, { type: "message", content: "gone" })).status).toBe(403);
    expect((await callback(s.bot, second, { type: "ephemeral", content: "still here, quietly" })).status).toBe(204);
    expect(await prisma.message.count()).toBe(0);
  });

  it("lets only one of two answers at once win", async () => {
    const s = await setup();
    const id = await ran(s);
    const results = await Promise.all([callback(s.bot, id, { type: "message", content: "first" }), callback(s.bot, id, { type: "message", content: "second" })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.message.count()).toBe(1);
  });

  it("keeps the name of who ran the command as it was then, and never names an erased account", async () => {
    const s = await setup();
    const id = await ran(s);
    await callback(s.bot, id, { type: "message", content: "Found it." });
    await prisma.user.update({ where: { protocolId: s.reader.user.id }, data: { displayName: "Renamed Later" } });
    expect((await messages(s))[0].interaction?.user.name).toBe("reader");

    const second = await ran(s, { title: "Again" });
    await callback(s.bot, second, { type: "message", content: "Again." });
    const owned = await prisma.user.findUniqueOrThrow({ where: { protocolId: s.reader.user.id } });
    expect((await purgeAccount(owned.id)).ok).toBe(true);
    expect((await prisma.message.findMany({ where: { content: { in: ["Found it.", "Again."] } } })).every((m) => m.interaction === null)).toBe(true);
    expect(await prisma.interaction.count({ where: { userId: owned.id } })).toBe(0);
  });
});

describe("keeping and removing", () => {
  it("removes interactions a day old, and only those", async () => {
    const s = await setup();
    const old = (await run(s, s.reader)).body.interaction.id as string;
    const recent = (await run(s, s.reader)).body.interaction.id as string;
    await prisma.interaction.update({ where: { protocolId: old }, data: { createdAt: new Date(Date.now() - INTERACTION_LIMITS.keepMs - 1000) } });
    expect(await pruneInteractions()).toBe(1);
    expect(await prisma.interaction.findUnique({ where: { protocolId: old } })).toBeNull();
    expect(await prisma.interaction.findUnique({ where: { protocolId: recent } })).not.toBeNull();
  });

  it("goes with a deleted bot, and a deleted command leaves the interaction without it", async () => {
    const s = await setup();
    const id = (await run(s, s.reader)).body.interaction.id as string;
    await register(s.bot, [{ name: "ping", description: "Pong" }]); // "request" is gone
    expect((await prisma.interaction.findUniqueOrThrow({ where: { protocolId: id } })).commandId).toBeNull();
    expect((await callback(s.bot, id, { type: "ephemeral", content: "still answerable" })).status).toBe(204);
    await api.delete(`/api/v1/bots/${s.bot.id}`).set(as(s.owner));
    expect(await prisma.interaction.count()).toBe(0);
  });
});

describe("the permission", () => {
  it("is a default: a community made now gives everyone the right to run commands, and the owner and every bit are in ALL", async () => {
    const s = await setup();
    const role = await prisma.role.findFirstOrThrow({ where: { community: { protocolId: s.community.id }, isDefault: true } });
    expect((role.permissions & Permission.USE_COMMANDS) === Permission.USE_COMMANDS).toBe(true);
    expect(Permission.USE_COMMANDS).toBe(8192n);
  });

  it("was given to every existing @everyone role by the migration, and to no other role", async () => {
    const s = await setup();
    const row = await prisma.community.findFirstOrThrow({ where: { protocolId: s.community.id } });
    const everyone = await prisma.role.findFirstOrThrow({ where: { communityId: row.id, isDefault: true } });
    const moderators = await prisma.role.create({ data: { communityId: row.id, name: "Mods", permissions: Permission.KICK_MEMBERS, position: 5 } });
    await prisma.role.update({ where: { id: everyone.id }, data: { permissions: Permission.SEND_MESSAGES } }); // as it was before the bit existed
    const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261105200000_slash_commands/migration.sql"), "utf8");
    const update = sql.split("\n").find((line) => line.startsWith("UPDATE"))!;
    await prisma.$executeRawUnsafe(update);
    expect((await prisma.role.findUniqueOrThrow({ where: { id: everyone.id } })).permissions).toBe(Permission.SEND_MESSAGES | Permission.USE_COMMANDS);
    expect((await prisma.role.findUniqueOrThrow({ where: { id: moderators.id } })).permissions).toBe(Permission.KICK_MEMBERS);
  });
});
