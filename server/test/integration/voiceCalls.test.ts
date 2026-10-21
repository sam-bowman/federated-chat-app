// Calls in direct and group conversations (#54): who may join (a member, when everyone in it is on this server), who is told when
// a call starts or ends, and what leaving the conversation does to a call. LiveKit is stood in for by `FakeVoice`; the real one is
// covered by the end-to-end test.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { setVoiceBackendForTests, stopAllWatching } from "../../src/modules/voice/service.js";
import { createWebSocketGateway } from "../../src/ws/gateway.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { FakeVoice } from "../helpers/voice.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const API_KEY = "test-key";
const API_SECRET = randomBytes(24).toString("hex");
const original = config.voice;

let voice: FakeVoice;
beforeEach(() => {
  voice = new FakeVoice();
  config.voice = { enabled: true, url: "wss://voice.test", internalUrl: "https://voice.test", apiKey: API_KEY, apiSecret: API_SECRET };
  setVoiceBackendForTests(voice);
});
afterEach(() => {
  stopAllWatching();
  config.voice = original;
  setVoiceBackendForTests(undefined);
});

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

type Registered = Awaited<ReturnType<typeof registerUser>>;
type CallEvent = { type: string; conversationId?: string; channelId?: string; participants?: string[] };

async function listen(user: Registered) {
  const events: CallEvent[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${user.accessToken}`);
  socket.on("message", (data) => events.push(JSON.parse(data.toString())));
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return events;
}
const callEvents = (events: CallEvent[]) => events.filter((e) => e.type === "voice:participants");
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
}

async function conversation(creator: Registered, type: "DM" | "GROUP", others: string[]) {
  const res = await api.post("/api/v1/conversations").set(authHeader(creator.accessToken)).send({ type, memberUsernames: others, title: type === "GROUP" ? "Crew" : undefined });
  expect(res.status).toBe(201);
  return res.body.conversation.id as string;
}
const tokenFor = (user: Registered, conversationId: string) => api.post(`/api/v1/conversations/${conversationId}/voice-token`).set(authHeader(user.accessToken));
const callsFor = (user: Registered) => api.get("/api/v1/conversations/voice").set(authHeader(user.accessToken));

async function webhook(event: object) {
  const body = JSON.stringify(event);
  const token = new AccessToken(API_KEY, API_SECRET);
  token.sha256 = createHash("sha256").update(body).digest("base64");
  return api.post("/api/v1/voice/webhook").set("Content-Type", "application/webhook+json").set("Authorization", await token.toJwt()).send(body);
}
const joined = (room: string, identity: string) => ({ event: "participant_joined", room: { name: room }, participant: { identity } });
const left = (room: string, identity: string) => ({ event: "participant_left", room: { name: room }, participant: { identity } });

/** A conversation with someone from another server in it (their stub is an ordinary user row marked remote). */
async function conversationWithRemote(local: Registered) {
  const me = await prisma.user.findUniqueOrThrow({ where: { protocolId: local.user.id } });
  const far = await prisma.user.create({
    data: { protocolId: "REMOTEFRIENDID0123456", username: "far-friend", displayName: "Far Friend", homeserverDomain: "far.test", isRemote: true },
  });
  const created = await prisma.conversation.create({
    data: { protocolId: "REMOTECONVERSATION012", type: "DM", members: { create: [{ userId: me.id }, { userId: far.id }] } },
  });
  return created.protocolId;
}

describe("joining a call in a conversation (POST /conversations/:id/voice-token)", () => {
  it("gives a member a token for that conversation's room, as themselves", async () => {
    const olive = await registerUser("olive");
    const max = await registerUser("max");
    const id = await conversation(olive, "DM", ["max"]);
    const res = await tokenFor(max, id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: "wss://voice.test", room: id, identity: max.user.id, expiresInSeconds: 600 });
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(res.body.token);
    expect(claims.sub).toBe(max.user.id);
    expect(claims.video).toMatchObject({ roomJoin: true, room: id, canSubscribe: true, canPublish: true, canPublishData: false });
    expect(claims.video?.canPublishSources).toEqual(["microphone"]);
  });

  it("works for a group, for each of its members", async () => {
    const olive = await registerUser("olive");
    const max = await registerUser("max");
    const sam = await registerUser("sam");
    const id = await conversation(olive, "GROUP", ["max", "sam"]);
    for (const person of [olive, max, sam]) expect((await tokenFor(person, id)).status).toBe(200);
  });

  it("does not exist for someone who is not in it, like a conversation that is not there", async () => {
    const olive = await registerUser("olive");
    await registerUser("max");
    const sam = await registerUser("sam");
    const id = await conversation(olive, "DM", ["max"]);
    expect((await tokenFor(sam, id)).status).toBe(404);
    expect((await tokenFor(olive, "NOSUCHCONVERSATION")).status).toBe(404);
    expect((await api.post(`/api/v1/conversations/${id}/voice-token`)).status).toBe(401);
  });

  it("is refused when someone in the conversation is on another server (federated voice is not built)", async () => {
    const olive = await registerUser("olive");
    const id = await conversationWithRemote(olive);
    const res = await tokenFor(olive, id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("voice_not_available_for_remote_conversation");
  });

  it("is not there on a server without voice", async () => {
    const olive = await registerUser("olive");
    await registerUser("max");
    const id = await conversation(olive, "DM", ["max"]);
    config.voice = { enabled: false };
    const res = await tokenFor(olive, id);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("voice_not_enabled");
  });
});

describe("who is in a call", () => {
  it("tells every member of the conversation, and nobody else, whenever someone joins or leaves", async () => {
    const olive = await registerUser("olive");
    const max = await registerUser("max");
    const sam = await registerUser("sam");
    const id = await conversation(olive, "DM", ["max"]);
    const maxEvents = await listen(max);
    const oliveEvents = await listen(olive);
    const samEvents = await listen(sam);

    voice.rooms.set(id, [olive.user.id]);
    expect((await webhook(joined(id, olive.user.id))).status).toBe(200);
    const ring = await until(() => callEvents(maxEvents)[0]);
    expect(ring).toEqual({ type: "voice:participants", conversationId: id, participants: [olive.user.id] });
    expect(ring).not.toHaveProperty("channelId");
    await until(() => callEvents(oliveEvents)[0]); // the caller is told too: it is how their own list stays right

    voice.rooms.set(id, [olive.user.id, max.user.id]);
    await webhook(joined(id, max.user.id));
    await until(() => callEvents(maxEvents)[1]);
    expect(callEvents(maxEvents)[1].participants).toEqual([olive.user.id, max.user.id]);

    voice.rooms.delete(id);
    await webhook(left(id, max.user.id));
    await until(() => callEvents(maxEvents)[2]);
    expect(callEvents(maxEvents)[2].participants).toEqual([]);

    await settle();
    expect(callEvents(samEvents)).toEqual([]);
  });

  it("says nothing for a conversation with someone on another server, which has no room here", async () => {
    const olive = await registerUser("olive");
    const id = await conversationWithRemote(olive);
    const events = await listen(olive);
    voice.rooms.set(id, [olive.user.id]);
    expect((await webhook(joined(id, olive.user.id))).status).toBe(200);
    await settle();
    expect(callEvents(events)).toEqual([]);
  });

  it("lists the calls going on in a person's conversations, and only those with someone in them", async () => {
    const olive = await registerUser("olive");
    const max = await registerUser("max");
    const sam = await registerUser("sam");
    const withMax = await conversation(olive, "DM", ["max"]);
    const quiet = await conversation(olive, "DM", ["sam"]);
    const others = await conversation(max, "DM", ["sam"]); // olive is not in it
    voice.rooms.set(withMax, [max.user.id]);
    voice.rooms.set(others, [sam.user.id]);

    const res = await callsFor(olive);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, calls: { [withMax]: [max.user.id] } });
    expect(Object.keys(res.body.calls)).not.toContain(quiet);
    expect(Object.keys(res.body.calls)).not.toContain(others);
  });

  it("leaves a conversation with someone on another server out of the list", async () => {
    const olive = await registerUser("olive");
    const id = await conversationWithRemote(olive);
    voice.rooms.set(id, ["SOMEONE"]);
    expect((await callsFor(olive)).body).toEqual({ available: true, calls: {} });
  });

  it("says it does not know, rather than that there are no calls, when the voice server cannot be asked or there is none", async () => {
    const olive = await registerUser("olive");
    await registerUser("max");
    const id = await conversation(olive, "DM", ["max"]);
    voice.rooms.set(id, [olive.user.id]);
    voice.failing = true;
    expect((await callsFor(olive)).body).toEqual({ available: false, calls: {} });
    voice.failing = false;
    config.voice = { enabled: false };
    expect((await callsFor(olive)).body).toEqual({ available: false, calls: {} });
    expect((await api.get("/api/v1/conversations/voice")).status).toBe(401);
  });

  it("is not mistaken for a conversation named 'voice' by the route that fetches one", async () => {
    const olive = await registerUser("olive");
    const res = await api.get("/api/v1/conversations/voice").set(authHeader(olive.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("calls");
  });
});

describe("leaving a conversation", () => {
  it("takes the person out of its call", async () => {
    const olive = await registerUser("olive");
    const max = await registerUser("max");
    const sam = await registerUser("sam");
    const id = await conversation(olive, "GROUP", ["max", "sam"]);
    voice.rooms.set(id, [olive.user.id, max.user.id]);
    expect((await api.delete(`/api/v1/conversations/${id}/members/me`).set(authHeader(max.accessToken))).status).toBe(204);
    expect(voice.removed).toEqual([`${id}:${max.user.id}`]);
    expect(sam.user.id).toBeTruthy();
  });

  it("still leaves when the voice server cannot be reached", async () => {
    const olive = await registerUser("olive");
    const max = await registerUser("max");
    const id = await conversation(olive, "DM", ["max"]);
    voice.failing = true;
    expect((await api.delete(`/api/v1/conversations/${id}/members/me`).set(authHeader(max.accessToken))).status).toBe(204);
    expect(await prisma.conversationMember.count({ where: { conversation: { protocolId: id } } })).toBe(1);
  });
});
