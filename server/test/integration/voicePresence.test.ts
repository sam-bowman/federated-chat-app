// Who is in a voice channel: LiveKit's webhooks, the list of who is in each channel, and taking people out of a call when they are
// removed from the community. LiveKit itself is stood in for by a fake (`FakeVoice`), since what is under test is what THIS server
// does with what LiveKit says and does to it; the real thing was run by hand and is covered by the end-to-end test.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AccessToken } from "livekit-server-sdk";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { localMemberIds, setVoiceBackendForTests, voiceStateOf } from "../../src/modules/voice/service.js";
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
  config.voice = original;
  setVoiceBackendForTests(undefined);
});

// --- websocket plumbing: what a signed-in client would hear
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
type VoiceEvent = { type: string; communityId?: string; channelId?: string; participants?: string[] };
async function listen(user: Registered) {
  const events: VoiceEvent[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${user.accessToken}`);
  socket.on("message", (data) => events.push(JSON.parse(data.toString())));
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return events;
}
const voiceEvents = (events: VoiceEvent[]) => events.filter((e) => e.type === "voice:participants");
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

type Registered = Awaited<ReturnType<typeof registerUser>>;
type Channel = { id: string; name: string; type: string };

async function createCommunity(owner: Registered, name = "Voice Test") {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community as { id: string; channels: Channel[] };
}
const join = async (community: { id: string }, user: Registered) =>
  expect((await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken))).status).toBe(201);
async function voiceChannel(owner: Registered, community: { id: string }, name = "Lounge") {
  const res = await api.post(`/api/v1/communities/${community.id}/channels`).set(authHeader(owner.accessToken)).send({ name, type: "VOICE" });
  expect(res.status).toBe(201);
  return res.body.channel as Channel;
}

/** A webhook as LiveKit sends it: the body as text, with a JWT over its hash signed with the shared secret. */
async function webhook(event: object, options: { secret?: string; tamper?: boolean; authorization?: string | null } = {}) {
  const body = JSON.stringify(event);
  const token = new AccessToken(API_KEY, options.secret ?? API_SECRET);
  token.sha256 = createHash("sha256").update(body).digest("base64");
  const authorization = options.authorization === undefined ? await token.toJwt() : options.authorization;
  const req = api.post("/api/v1/voice/webhook").set("Content-Type", "application/webhook+json");
  if (authorization !== null) req.set("Authorization", authorization);
  return req.send(options.tamper ? body.replace("participant", "participent") : body);
}
const joined = (room: string, identity: string) => ({ event: "participant_joined", room: { name: room }, participant: { identity } });
const left = (room: string, identity: string) => ({ event: "participant_left", room: { name: room }, participant: { identity } });

describe("the voice server's webhook (POST /voice/webhook)", () => {
  it("tells the community's members who is in the channel, from what the voice server says is there", async () => {
    const owner = await registerUser("olive");
    const member = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, member);
    const channel = await voiceChannel(owner, community);
    const events = await listen(member);

    voice.rooms.set(channel.id, [owner.user.id]);
    expect((await webhook(joined(channel.id, owner.user.id))).status).toBe(200);
    const first = await until(() => voiceEvents(events)[0]);
    expect(first).toEqual({ type: "voice:participants", communityId: community.id, channelId: channel.id, participants: [owner.user.id] });

    voice.rooms.set(channel.id, [owner.user.id, member.user.id]);
    await webhook(joined(channel.id, member.user.id));
    await until(() => voiceEvents(events)[1]);
    expect(voiceEvents(events)[1].participants).toEqual([owner.user.id, member.user.id]);

    voice.rooms.set(channel.id, [member.user.id]);
    await webhook(left(channel.id, owner.user.id));
    await until(() => voiceEvents(events)[2]);
    expect(voiceEvents(events)[2].participants).toEqual([member.user.id]);

    voice.rooms.delete(channel.id);
    await webhook(left(channel.id, member.user.id));
    await until(() => voiceEvents(events)[3]);
    expect(voiceEvents(events)[3].participants).toEqual([]);
  });

  it("tells members of that community and nobody else", async () => {
    const owner = await registerUser("olive");
    const member = await registerUser("max");
    const stranger = await registerUser("sam");
    const community = await createCommunity(owner);
    await join(community, member);
    const channel = await voiceChannel(owner, community);
    const memberEvents = await listen(member);
    const strangerEvents = await listen(stranger);

    voice.rooms.set(channel.id, [owner.user.id]);
    await webhook(joined(channel.id, owner.user.id));
    await until(() => voiceEvents(memberEvents)[0]);
    await settle();
    expect(voiceEvents(strangerEvents)).toEqual([]);
  });

  it("believes only the voice server: a missing, wrong or stale signature is refused, and nothing is sent", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    const events = await listen(owner);
    voice.rooms.set(channel.id, [owner.user.id]);

    const wrongSecret = await webhook(joined(channel.id, owner.user.id), { secret: randomBytes(24).toString("hex") });
    const tampered = await webhook(joined(channel.id, owner.user.id), { tamper: true });
    const noHeader = await webhook(joined(channel.id, owner.user.id), { authorization: null });
    const junk = await webhook(joined(channel.id, owner.user.id), { authorization: "not a token" });
    for (const res of [wrongSecret, tampered, noHeader, junk]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("invalid_signature");
    }
    await settle();
    expect(voiceEvents(events)).toEqual([]);
  });

  it("does not exist on a server without voice", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    config.voice = { enabled: false };
    const res = await webhook(joined(channel.id, owner.user.id));
    expect(res.status).toBe(404);
  });

  it("acknowledges and ignores what is not about someone joining or leaving a voice channel of ours", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    const events = await listen(owner);
    voice.rooms.set(channel.id, [owner.user.id]);

    for (const event of [
      { event: "room_started", room: { name: channel.id } },
      { event: "track_published", room: { name: channel.id }, participant: { identity: owner.user.id } },
      joined("NO-SUCH-ROOM", owner.user.id),
      joined(community.channels[0].id, owner.user.id), // a text channel's id
      { event: "participant_joined", participant: { identity: owner.user.id } }, // no room
    ]) {
      expect((await webhook(event)).status, JSON.stringify(event)).toBe(200);
    }
    await settle();
    expect(voiceEvents(events)).toEqual([]);

    // An event with no room is not looked up at all (there is nothing to look for).
    const lookup = vi.spyOn(prisma.channel, "findUnique");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await webhook({ event: "participant_joined", participant: { identity: owner.user.id } })).status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled(); // and it is not an error either
    lookup.mockRestore();
    logged.mockRestore();
  });

  it("ignores a room of a community that lives on another server", async () => {
    const alice = await registerUser("alice");
    const aliceLocal = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const remoteOwner = await prisma.user.create({
      data: { protocolId: "REMOTEOWNERID012345", username: "remote-owner", displayName: "Remote Owner", homeserverDomain: "far.test", isRemote: true },
    });
    const community = await prisma.community.create({
      data: { protocolId: "REMOTECOMMUNITYID01", name: "Remote", ownerId: remoteOwner.id, homeserverDomain: "far.test", isRemote: true },
    });
    const channel = await prisma.channel.create({ data: { protocolId: "REMOTEVOICEID0123456", communityId: community.id, name: "Lounge", position: 0, type: "VOICE" } });
    await prisma.communityMember.create({ data: { communityId: community.id, userId: aliceLocal.id } });
    const events = await listen(alice);
    voice.rooms.set(channel.protocolId, [alice.user.id]);

    expect((await webhook(joined(channel.protocolId, alice.user.id))).status).toBe(200);
    await settle();
    expect(voiceEvents(events)).toEqual([]);
  });

  it("still answers 200 when something on this side fails (the database, say), rather than making the voice server send the same thing again", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    const lookup = vi.spyOn(prisma.channel, "findUnique").mockRejectedValueOnce(new Error("database is down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await webhook(joined(channel.id, owner.user.id));
    lookup.mockRestore();
    expect(res.status).toBe(200);
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("still answers 200 when the voice server cannot be asked right now, rather than making it send the same thing again", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    const events = await listen(owner);
    voice.failing = true;
    expect((await webhook(joined(channel.id, owner.user.id))).status).toBe(200);
    await settle();
    expect(voiceEvents(events)).toEqual([]);
  });
});

describe("GET /communities/:id/voice", () => {
  it("lists who is in each voice channel, and only the voice channels", async () => {
    const owner = await registerUser("olive");
    const member = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, member);
    const lounge = await voiceChannel(owner, community, "Lounge");
    const quiet = await voiceChannel(owner, community, "Quiet");
    voice.rooms.set(lounge.id, [owner.user.id, member.user.id]);
    voice.rooms.set(community.channels[0].id, ["SOMEONE"]); // a text channel is never asked about

    const res = await api.get(`/api/v1/communities/${community.id}/voice`).set(authHeader(member.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, channels: { [lounge.id]: [owner.user.id, member.user.id], [quiet.id]: [] } });
  });

  it("is for members: an outsider is refused and an unknown community is not found", async () => {
    const owner = await registerUser("olive");
    const stranger = await registerUser("sam");
    const community = await createCommunity(owner);
    await voiceChannel(owner, community);
    expect((await api.get(`/api/v1/communities/${community.id}/voice`).set(authHeader(stranger.accessToken))).status).toBe(403);
    expect((await api.get("/api/v1/communities/NOSUCHCOMMUNITY/voice").set(authHeader(owner.accessToken))).status).toBe(404);
    expect((await api.get(`/api/v1/communities/${community.id}/voice`)).status).toBe(401);
  });

  it("says voice is not available where there is nothing to ask", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    await voiceChannel(owner, community);
    config.voice = { enabled: false };
    const res = await api.get(`/api/v1/communities/${community.id}/voice`).set(authHeader(owner.accessToken));
    expect(res.body).toEqual({ available: false, channels: {} });
  });

  it("says voice is not available for a community that lives on another server, even though this server has voice", async () => {
    const alice = await registerUser("alice");
    const aliceLocal = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const remoteOwner = await prisma.user.create({
      data: { protocolId: "REMOTEOWNERID012345", username: "remote-owner", displayName: "Remote Owner", homeserverDomain: "far.test", isRemote: true },
    });
    const community = await prisma.community.create({
      data: { protocolId: "REMOTECOMMUNITYID01", name: "Remote", ownerId: remoteOwner.id, homeserverDomain: "far.test", isRemote: true },
    });
    await prisma.channel.create({ data: { protocolId: "REMOTEVOICEID0123456", communityId: community.id, name: "Lounge", position: 0, type: "VOICE" } });
    await prisma.communityMember.create({ data: { communityId: community.id, userId: aliceLocal.id } });
    voice.rooms.set("REMOTEVOICEID0123456", ["SOMEONE"]);

    const res = await api.get(`/api/v1/communities/${community.protocolId}/voice`).set(authHeader(alice.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, channels: {} });
  });

  it("says voice is not available on a server with none, even for a community with no voice channels to ask about", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    config.voice = { enabled: false };
    const res = await api.get(`/api/v1/communities/${community.id}/voice`).set(authHeader(owner.accessToken));
    expect(res.body).toEqual({ available: false, channels: {} });
  });

  it("says the list cannot be trusted when the voice server does not answer, instead of showing every channel empty", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    await voiceChannel(owner, community);
    voice.failing = true;
    const res = await api.get(`/api/v1/communities/${community.id}/voice`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, channels: {} });
  });
});

describe("taking people out of a call when they leave the community", () => {
  async function setup() {
    const owner = await registerUser("olive");
    const member = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, member);
    const lounge = await voiceChannel(owner, community, "Lounge");
    const second = await voiceChannel(owner, community, "Second");
    voice.rooms.set(lounge.id, [member.user.id]);
    voice.rooms.set(second.id, [member.user.id]);
    return { owner, member, community, lounge, second };
  }

  it("when they are kicked: out of every voice channel of that community, not of another", async () => {
    const { owner, member, community, lounge, second } = await setup();
    const other = await createCommunity(owner, "Other");
    const elsewhere = await voiceChannel(owner, other);
    voice.rooms.set(elsewhere.id, [member.user.id]);

    const res = await api.delete(`/api/v1/communities/${community.id}/members/${member.user.id}`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(204);
    expect(voice.removed.sort()).toEqual([`${lounge.id}:${member.user.id}`, `${second.id}:${member.user.id}`].sort());
    expect(voice.rooms.get(elsewhere.id)).toEqual([member.user.id]);
  });

  it("when they are banned", async () => {
    const { owner, member, community, lounge, second } = await setup();
    const res = await api.post(`/api/v1/communities/${community.id}/bans`).set(authHeader(owner.accessToken)).send({ protocolId: member.user.id });
    expect(res.status).toBe(204);
    expect(voice.removed.sort()).toEqual([`${lounge.id}:${member.user.id}`, `${second.id}:${member.user.id}`].sort());
  });

  it("when they leave", async () => {
    const { member, community, lounge, second } = await setup();
    const res = await api.delete(`/api/v1/communities/${community.id}/members/me`).set(authHeader(member.accessToken));
    expect(res.status).toBe(204);
    expect(voice.removed.sort()).toEqual([`${lounge.id}:${member.user.id}`, `${second.id}:${member.user.id}`].sort());
  });

  it("without the removal failing if the voice server cannot be reached", async () => {
    const { owner, member, community } = await setup();
    voice.failing = true;
    const res = await api.delete(`/api/v1/communities/${community.id}/members/${member.user.id}`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(204);
    expect(await prisma.communityMember.count({ where: { user: { protocolId: member.user.id }, community: { protocolId: community.id } } })).toBe(0);
  });

  it("and does nothing at all on a server without voice", async () => {
    const { owner, member, community } = await setup();
    config.voice = { enabled: false };
    const res = await api.delete(`/api/v1/communities/${community.id}/members/${member.user.id}`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(204);
    expect(voice.removed).toEqual([]);
  });
});

describe("closing rooms that are gone", () => {
  it("closes the room of a voice channel that is deleted, and no room for a text channel", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const lounge = await voiceChannel(owner, community);
    const text = (await api.post(`/api/v1/communities/${community.id}/channels`).set(authHeader(owner.accessToken)).send({ name: "chat" })).body.channel as Channel;

    expect((await api.delete(`/api/v1/communities/${community.id}/channels/${text.id}`).set(authHeader(owner.accessToken))).status).toBe(204);
    expect(voice.deleted).toEqual([]);
    expect((await api.delete(`/api/v1/communities/${community.id}/channels/${lounge.id}`).set(authHeader(owner.accessToken))).status).toBe(204);
    expect(voice.deleted).toEqual([lounge.id]);
  });

  it("closes every voice room of a community that is deleted", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const one = await voiceChannel(owner, community, "One");
    const two = await voiceChannel(owner, community, "Two");
    expect((await api.delete(`/api/v1/communities/${community.id}`).set(authHeader(owner.accessToken))).status).toBe(204);
    expect(voice.deleted.sort()).toEqual([one.id, two.id].sort());
  });

  it("does not fail the deletion if the voice server cannot be reached", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const lounge = await voiceChannel(owner, community);
    voice.failing = true;
    expect((await api.delete(`/api/v1/communities/${community.id}/channels/${lounge.id}`).set(authHeader(owner.accessToken))).status).toBe(204);
  });
});

describe("what the voice service reads", () => {
  it("does not know who is in a room when there is no voice server to ask, which is not the same as nobody", async () => {
    config.voice = { enabled: false };
    expect(await voiceStateOf(["ROOM1", "ROOM2"])).toEqual({ ROOM1: null, ROOM2: null });
  });

  it("tells the community's members on this server, and not the cached copies of people on other servers", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const row = await prisma.community.findFirstOrThrow({ where: { protocolId: community.id } });
    const remote = await prisma.user.create({
      data: { protocolId: "REMOTEMEMBERID012345", username: "far", displayName: "Far", homeserverDomain: "far.test", isRemote: true },
    });
    await prisma.communityMember.create({ data: { communityId: row.id, userId: remote.id } });
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: owner.user.id } });
    expect(await localMemberIds(row.id)).toEqual([ownerRow.id]);
  });
});
