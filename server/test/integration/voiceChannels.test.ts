// Voice channels on the server: making one, who may join it (a short-lived LiveKit token), and that it carries no messages.
// No LiveKit is needed here: the token is a signed JWT, checked with the SDK's own verifier.
import { randomBytes } from "node:crypto";
import { TokenVerifier } from "livekit-server-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { DEFAULT_MEMBER_PERMISSIONS, Permission } from "../../src/lib/permissions.js";
import { applyCommunitySnapshot, buildCommunitySnapshot, channelTypeOf } from "../../src/modules/federation/communitySnapshot.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const API_KEY = "test-key";
// Made up for each run: a literal that long looks like a leaked key to the secret scanner.
const API_SECRET = randomBytes(24).toString("hex");
const original = config.voice;
const voiceOn = () => {
  config.voice = { enabled: true, url: "wss://voice.test", internalUrl: "https://voice.test", apiKey: API_KEY, apiSecret: API_SECRET };
};
afterEach(() => {
  config.voice = original;
});

type Registered = Awaited<ReturnType<typeof registerUser>>;
type Channel = { id: string; name: string; type: string };

async function createCommunity(owner: Registered) {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name: "Voice Test" });
  expect(res.status).toBe(201);
  return res.body.community as { id: string; channels: Channel[] };
}
const join = async (community: { id: string }, user: Registered) =>
  expect((await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken))).status).toBe(201);
const addChannel = (owner: Registered, community: { id: string }, body: object) =>
  api.post(`/api/v1/communities/${community.id}/channels`).set(authHeader(owner.accessToken)).send(body);
const tokenFor = (user: Registered, channelId: string) => api.post(`/api/v1/channels/${channelId}/voice-token`).set(authHeader(user.accessToken));

async function voiceChannel(owner: Registered, community: { id: string }) {
  const res = await addChannel(owner, community, { name: "Lounge", type: "VOICE" });
  expect(res.status).toBe(201);
  return res.body.channel as Channel;
}

describe("making a voice channel", () => {
  it("is a text channel unless it says otherwise", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const res = await addChannel(owner, community, { name: "plain" });
    expect(res.status).toBe(201);
    expect(res.body.channel.type).toBe("TEXT");
    expect(community.channels[0].type).toBe("TEXT");
  });

  it("can be a voice channel when this server has voice, and says so everywhere the channel is shown", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    expect(channel.type).toBe("VOICE");

    const shown = await api.get(`/api/v1/communities/${community.id}`).set(authHeader(owner.accessToken));
    expect(shown.body.community.channels.find((c: Channel) => c.id === channel.id).type).toBe("VOICE");
    expect(await prisma.channel.findUniqueOrThrow({ where: { protocolId: channel.id } })).toMatchObject({ type: "VOICE" });
  });

  it("is refused on a server with no voice, rather than made and then unjoinable, while a text channel is still fine", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const res = await addChannel(owner, community, { name: "Lounge", type: "VOICE" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("voice_not_enabled");
    expect((await addChannel(owner, community, { name: "text", type: "TEXT" })).status).toBe(201);
    expect(await prisma.channel.count({ where: { name: "Lounge" } })).toBe(0);
  });

  it("is for people who may manage channels, and only a type the server knows", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const member = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, member);
    expect((await addChannel(member, community, { name: "Lounge", type: "VOICE" })).status).toBe(403);
    expect((await addChannel(owner, community, { name: "Lounge", type: "VIDEO" })).status).toBe(400);
    expect((await addChannel(owner, community, { name: "Lounge", type: "voice" })).status).toBe(400);
  });

  it("can be renamed like any channel and keeps its type", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    const res = await api.patch(`/api/v1/communities/${community.id}/channels/${channel.id}`).set(authHeader(owner.accessToken)).send({ name: "Lounge 2" });
    expect(res.status).toBe(200);
    expect(res.body.channel).toMatchObject({ name: "Lounge 2", type: "VOICE" });
  });
});

describe("joining a voice channel (POST /channels/:id/voice-token)", () => {
  it("gives a member a token for that channel's room, as themselves, for the voice server to accept", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const member = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, member);
    const channel = await voiceChannel(owner, community);

    // Shown to others as the display name, which is not the username.
    expect((await api.patch("/api/v1/users/me").set(authHeader(member.accessToken)).send({ displayName: "Max the Member" })).status).toBe(200);
    const res = await tokenFor(member, channel.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: "wss://voice.test", room: channel.id, identity: member.user.id, expiresInSeconds: 600 });

    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(res.body.token);
    expect(claims.sub).toBe(member.user.id);
    expect(claims.name).toBe("Max the Member");
    expect(claims.video).toMatchObject({ roomJoin: true, room: channel.id, canSubscribe: true, canPublish: true, canPublishData: false });
    expect(claims.video?.canPublishSources).toEqual(["microphone"]);
  });

  it("gives each person their own identity, and each channel its own room", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const member = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, member);
    const one = await voiceChannel(owner, community);
    const two = (await addChannel(owner, community, { name: "Second", type: "VOICE" })).body.channel as Channel;

    const verifier = new TokenVerifier(API_KEY, API_SECRET);
    const a = await verifier.verify((await tokenFor(owner, one.id)).body.token);
    const b = await verifier.verify((await tokenFor(member, one.id)).body.token);
    const c = await verifier.verify((await tokenFor(member, two.id)).body.token);
    expect(a.sub).toBe(owner.user.id);
    expect(b.sub).toBe(member.user.id);
    expect(a.video?.room).toBe(one.id);
    expect(c.video?.room).toBe(two.id);
  });

  it("needs a signed-in person", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    expect((await api.post(`/api/v1/channels/${channel.id}/voice-token`)).status).toBe(401);
  });

  it("is not there on a server without voice", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const res = await tokenFor(owner, community.channels[0].id);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("voice_not_enabled");
  });

  it("does not exist for someone outside the community, just like a channel that is not there", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const stranger = await registerUser("sam");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    const outside = await tokenFor(stranger, channel.id);
    const missing = await tokenFor(stranger, "NOSUCHCHANNEL");
    expect(outside.status).toBe(404);
    expect(outside.body).toEqual(missing.body);
  });

  it("is for voice channels: a text channel answers that it is not one", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const res = await tokenFor(owner, community.channels[0].id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_a_voice_channel");
  });

  it("needs the Connect voice permission, which members have until a manager takes it away", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const member = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, member);
    const channel = await voiceChannel(owner, community);
    const row = await prisma.community.findFirstOrThrow({ where: { protocolId: community.id } });
    const everyone = await prisma.role.findFirstOrThrow({ where: { communityId: row.id, isDefault: true } });
    expect(everyone.permissions & Permission.CONNECT_VOICE).toBe(Permission.CONNECT_VOICE);

    expect((await tokenFor(member, channel.id)).status).toBe(200);

    await prisma.role.update({ where: { id: everyone.id }, data: { permissions: DEFAULT_MEMBER_PERMISSIONS & ~Permission.CONNECT_VOICE } });
    const refused = await tokenFor(member, channel.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("forbidden");
    // The owner holds every permission, so taking it from @everyone does not lock them out of their own channel.
    expect((await tokenFor(owner, channel.id)).status).toBe(200);
  });

  it("can be given back through another role, since a person's permissions are the sum of their roles", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const member = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, member);
    const channel = await voiceChannel(owner, community);
    const row = await prisma.community.findFirstOrThrow({ where: { protocolId: community.id } });
    const everyone = await prisma.role.findFirstOrThrow({ where: { communityId: row.id, isDefault: true } });
    await prisma.role.update({ where: { id: everyone.id }, data: { permissions: DEFAULT_MEMBER_PERMISSIONS & ~Permission.CONNECT_VOICE } });
    expect((await tokenFor(member, channel.id)).status).toBe(403);

    const speakers = await prisma.role.create({ data: { communityId: row.id, name: "Speakers", permissions: Permission.CONNECT_VOICE, position: 1 } });
    const memberRow = await prisma.communityMember.findFirstOrThrow({ where: { communityId: row.id, user: { protocolId: member.user.id } } });
    await prisma.memberRole.create({ data: { memberId: memberRow.id, roleId: speakers.id } });
    expect((await tokenFor(member, channel.id)).status).toBe(200);
  });

  it("is not available for a community that lives on another server: this server has no room for it", async () => {
    voiceOn();
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

    const res = await tokenFor(alice, channel.protocolId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("voice_not_available_for_remote_community");
  });
});

describe("a voice channel has no messages", () => {
  it("refuses to list, send or mark them, with the reason, and a text channel is unaffected", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);

    const list = await api.get(`/api/v1/channels/${channel.id}/messages`).set(authHeader(owner.accessToken));
    const send = await api.post(`/api/v1/channels/${channel.id}/messages`).set(authHeader(owner.accessToken)).send({ content: "hello?" });
    const read = await api.post(`/api/v1/channels/${channel.id}/read`).set(authHeader(owner.accessToken));
    for (const res of [list, send, read]) {
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("not_a_text_channel");
    }
    expect(await prisma.message.count()).toBe(0);

    const text = community.channels[0].id;
    expect((await api.post(`/api/v1/channels/${text}/messages`).set(authHeader(owner.accessToken)).send({ content: "hello" })).status).toBe(201);
    expect((await api.get(`/api/v1/channels/${text}/messages`).set(authHeader(owner.accessToken))).status).toBe(200);
  });

  it("is also refused when a member on another server sends one through their own server", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    const alice = await registerTestPeer("alice.test");
    const joined = await signedPost(alice, `/federation/v1/communities/${community.id}/members`, { protocolId: newProtocolId(), username: "alice", displayName: "Alice" });
    expect(joined.status).toBe(201);

    const refused = await signedPost(alice, `/federation/v1/communities/${community.id}/channels/${channel.id}/messages`, { username: "alice", content: "hello?" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("not_a_text_channel");
    expect(await prisma.message.count()).toBe(0);

    // The same call into the text channel still works, so it is the channel type that was refused, not the caller.
    const text = await signedPost(alice, `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages`, { username: "alice", content: "hello" });
    expect(text.status).toBe(201);
  });
});

describe("a channel type from another server", () => {
  it("is kept when it is one we know and is text otherwise, since it is a stranger's value", () => {
    expect(channelTypeOf("VOICE")).toBe("VOICE");
    expect(channelTypeOf("TEXT")).toBe("TEXT");
    for (const value of ["voice", "VIDEO", "", null, undefined, 1, {}, ["VOICE"]]) expect(channelTypeOf(value), String(value)).toBe("TEXT");
  });
});

describe("voice channels in a community snapshot", () => {
  it("are sent to other servers as voice channels", async () => {
    voiceOn();
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const channel = await voiceChannel(owner, community);
    const row = await prisma.community.findFirstOrThrow({ where: { protocolId: community.id } });
    const snapshot = await buildCommunitySnapshot(row.id);
    expect(snapshot.channels.find((c) => c.protocolId === channel.id)?.type).toBe("VOICE");
    expect(snapshot.channels.find((c) => c.protocolId === community.channels[0].id)?.type).toBe("TEXT");
  });

  it("are cached as voice channels, and a type this server does not know is cached as text, since it came from a stranger", async () => {
    await registerTestPeer("far.test");
    const owner = {
      protocolId: "REMOTEOWNERID012345", username: "remote-owner", domain: "far.test", displayName: "Remote Owner", avatarUrl: null,
    };
    const channels = [
      { protocolId: "SNAPVOICE0000000001", name: "Lounge", topic: null, position: 0, type: "VOICE" as const },
      { protocolId: "SNAPTEXT00000000002", name: "general", topic: null, position: 1, type: "TEXT" as const },
      { protocolId: "SNAPODD000000000003", name: "odd", topic: null, position: 2, type: "SOMETHING" as unknown as "TEXT" },
    ];
    await applyCommunitySnapshot({ protocolId: "REMOTECOMMUNITYID01", name: "Remote", description: null, iconUrl: null, owner, channels }, "far.test");
    const cached = await prisma.channel.findMany({ where: { protocolId: { in: channels.map((c) => c.protocolId) } }, orderBy: { position: "asc" } });
    expect(cached.map((c) => c.type)).toEqual(["VOICE", "TEXT", "TEXT"]);

    // A later snapshot that changes a channel's type is followed.
    await applyCommunitySnapshot(
      { protocolId: "REMOTECOMMUNITYID01", name: "Remote", description: null, iconUrl: null, owner, channels: [{ ...channels[0], type: "TEXT" }] },
      "far.test"
    );
    expect((await prisma.channel.findUniqueOrThrow({ where: { protocolId: "SNAPVOICE0000000001" } })).type).toBe("TEXT");
  });
});

describe("the discovery document", () => {
  it("says whether voice channels can be joined here", async () => {
    expect((await api.get("/.well-known/communication-platform")).body.features.voice).toBe(false);
    voiceOn();
    expect((await api.get("/.well-known/communication-platform")).body.features.voice).toBe(true);
  });
});
