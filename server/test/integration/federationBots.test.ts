import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

// A bot's Bot badge on other servers (#132): the server a bot lives on says so in the messages and reactions it relays, and the server that
// receives them keeps it on the cached person. Until now a person on another server saw a bot's messages as a person's.
beforeEach(resetDb);
afterAll(disconnectDb);

const HOME = "alice.test";

/** A community this server only caches (its home is `alice.test`) with one channel, and the peer that is its home. */
async function cachedCommunity() {
  const peer = await registerTestPeer(HOME);
  const owner = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "olive", displayName: "olive", homeserverDomain: HOME, isRemote: true } });
  const community = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far Club", ownerId: owner.id, homeserverDomain: HOME, isRemote: true } });
  const channel = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: community.id, name: "general", position: 0 } });
  return { peer, community, channel };
}

const stub = (username: string) => prisma.user.findFirstOrThrow({ where: { username, homeserverDomain: HOME } });

describe("a bot's messages arriving from another server", () => {
  it("make the cached person a bot, and a payload that says nothing leaves it as it is", async () => {
    const { peer, community, channel } = await cachedCommunity();
    const path = `/federation/v1/communities/${community.protocolId}/channels/${channel.protocolId}/messages`;
    const message = (extra: Record<string, unknown>) => ({
      messageId: newProtocolId(),
      fromProtocolId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      fromUsername: "robo",
      fromDomain: HOME,
      content: "beep",
      ...extra,
    });

    expect((await signedPost(peer, path, message({ fromIsBot: true }))).status).toBe(201);
    expect((await stub("robo")).isBot).toBe(true);

    // An older server says nothing: what is cached stays.
    expect((await signedPost(peer, path, message({}))).status).toBe(201);
    expect((await stub("robo")).isBot).toBe(true);

    // The server that knows the person is the authority, both ways.
    expect((await signedPost(peer, path, message({ fromIsBot: false }))).status).toBe(201);
    expect((await stub("robo")).isBot).toBe(false);
  });

  it("are drawn to a local member with the sender marked as a bot", async () => {
    const { peer, community, channel } = await cachedCommunity();
    const me = await registerUser("reader");
    const row = await prisma.user.findFirstOrThrow({ where: { protocolId: me.user.id } });
    await prisma.communityMember.create({ data: { communityId: community.id, userId: row.id } });
    await signedPost(peer, `/federation/v1/communities/${community.protocolId}/channels/${channel.protocolId}/messages`, {
      messageId: newProtocolId(),
      fromProtocolId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      fromUsername: "robo",
      fromDomain: HOME,
      fromIsBot: true,
      content: "beep",
    });
    const history = await api.get(`/api/v1/channels/${channel.protocolId}/messages`).set(authHeader(me.accessToken));
    expect(history.status).toBe(200);
    expect(history.body.messages[0].sender.isBot).toBe(true);
  });

  it("only count for the server's own people: a payload cannot make someone on another domain a bot", async () => {
    const { peer, community, channel } = await cachedCommunity();
    const victim = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "vic", displayName: "vic", homeserverDomain: "other.test", isRemote: true } });
    const res = await signedPost(peer, `/federation/v1/communities/${community.protocolId}/channels/${channel.protocolId}/messages`, {
      messageId: newProtocolId(),
      fromProtocolId: victim.protocolId,
      fromUsername: "vic",
      fromDomain: "other.test",
      fromIsBot: true,
      content: "x",
    });
    expect(res.status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).isBot).toBe(false);
  });
});

describe("a bot's reactions arriving from another server", () => {
  it("make the cached reactor a bot", async () => {
    const { peer, community, channel } = await cachedCommunity();
    const author = await prisma.user.findFirstOrThrow({ where: { username: "olive" } });
    const message = await prisma.message.create({ data: { protocolId: newProtocolId(), channelId: channel.id, senderId: author.id, content: "hi" } });
    const res = await signedPost(
      peer,
      `/federation/v1/communities/${community.protocolId}/channels/${channel.protocolId}/messages/${message.protocolId}/reactions`,
      { fromDomain: HOME, fromProtocolId: "01HYYYYYYYYYYYYYYYYYYYYYYY", fromUsername: "robo", fromIsBot: true, emoji: "👍" }
    );
    expect(res.status).toBeLessThan(300);
    expect((await stub("robo")).isBot).toBe(true);
  });
});

describe("what this server sends about its own bot", () => {
  async function communityWithRemoteMember() {
    const owner = await registerUser("owner");
    const community = (await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name: "Club" })).body.community;
    const made = await api.post("/api/v1/bots").set(authHeader(owner.accessToken)).send({ username: "robo" });
    await api.post(`/api/v1/communities/${community.id}/bots`).set(authHeader(owner.accessToken)).send({ username: "robo" });
    const row = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
    const far = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "far", displayName: "far", homeserverDomain: "far.test", isRemote: true } });
    await prisma.communityMember.create({ data: { communityId: row.id, userId: far.id } });
    return { owner, community, bot: { Authorization: `Bot ${made.body.token}` } };
  }

  it("says a message is from a bot, and a person's is not", async () => {
    const { owner, community, bot } = await communityWithRemoteMember();
    const channelId = community.channels[0].id;
    await api.post(`/api/v1/channels/${channelId}/messages`).set(bot).send({ content: "from the bot" });
    await api.post(`/api/v1/channels/${channelId}/messages`).set(authHeader(owner.accessToken)).send({ content: "from a person" });
    const sent = await prisma.federationOutboxEvent.findMany({ where: { path: { contains: "/messages" }, domain: "far.test" } });
    const byContent = Object.fromEntries(sent.map((e) => [(e.body as { content: string }).content, (e.body as { fromIsBot: boolean }).fromIsBot]));
    expect(byContent).toEqual({ "from the bot": true, "from a person": false });
  });

  it("says a reaction is from a bot", async () => {
    const { owner, community, bot } = await communityWithRemoteMember();
    const posted = await api.post(`/api/v1/channels/${community.channels[0].id}/messages`).set(authHeader(owner.accessToken)).send({ content: "hello" });
    await api.post(`/api/v1/messages/${posted.body.message.id}/reactions`).set(bot).send({ emoji: "👍" });
    const reactions = await prisma.federationOutboxEvent.findMany({ where: { path: { endsWith: "/reactions" }, domain: "far.test" } });
    expect(reactions.map((e) => (e.body as { fromIsBot: boolean }).fromIsBot)).toEqual([true]);
  });
});
