// Reactions with a custom emoticon (#110): who may use which emoticon, the shape everyone sees, what other
// servers are sent and what we accept from them, and what happens when the emoticon goes away.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { waitForPendingDeliveries } from "../../src/lib/federation/outbox.js";
import { ensureRemoteUser } from "../../src/modules/federation/remoteUsers.js";
import { api } from "../helpers/app.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;

async function makeEmoticon(user: Registered, name: string, extra: Record<string, unknown> = {}) {
  const res = await api
    .post("/api/v1/emoticons")
    .set(authHeader(user.accessToken))
    .send({ name, trigger: `:${name.toLowerCase()}:`, imageUrl: `/uploads/${name.toLowerCase()}.png`, ...extra });
  expect(res.status).toBe(201);
  return res.body.emoticon as { id: string; name: string; imageUrl: string };
}

async function dmWithMessage() {
  const alice = await registerUser("alice");
  const bob = await registerUser("bob");
  const convo = await api
    .post("/api/v1/conversations")
    .set(authHeader(alice.accessToken))
    .send({ type: "DM", memberUsernames: [bob.user.username] });
  const send = await api
    .post(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
    .set(authHeader(alice.accessToken))
    .send({ content: "hello" });
  return { alice, bob, conversationId: convo.body.conversation.id as string, messageId: send.body.message.id as string };
}

const react = (user: Registered, messageId: string, body: unknown) =>
  api.post(`/api/v1/messages/${messageId}/reactions`).set(authHeader(user.accessToken)).send(body as object);
const unreact = (user: Registered, messageId: string, emoticonId: string) =>
  api.delete(`/api/v1/messages/${messageId}/emoticon-reactions/${emoticonId}`).set(authHeader(user.accessToken));

describe("reacting with a custom emoticon (local)", () => {
  it("shows a custom reaction as the emoticon's name and picture, never a trigger", async () => {
    const { bob, messageId } = await dmWithMessage();
    const party = await makeEmoticon(bob, "Party");

    const res = await react(bob, messageId, { emoticonId: party.id });
    expect(res.status).toBe(200);
    expect(res.body.message.reactions).toEqual([
      { emoticon: { id: party.id, name: "Party", imageUrl: "/uploads/party.png" }, count: 1, users: ["bob"] },
    ]);
    expect(res.body.message.reactions[0]).not.toHaveProperty("emoji");
  });

  it("is the same for the other person, who does not have that emoticon at all", async () => {
    const { alice, bob, conversationId, messageId } = await dmWithMessage();
    const party = await makeEmoticon(bob, "Party");
    await react(bob, messageId, { emoticonId: party.id });

    const seen = await api.get(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken));
    expect(seen.body.messages[0].reactions).toEqual([
      { emoticon: { id: party.id, name: "Party", imageUrl: "/uploads/party.png" }, count: 1, users: ["bob"] },
    ]);
  });

  it("is one reaction however many times it is added, and several people join the same one", async () => {
    const { alice, bob, messageId } = await dmWithMessage();
    const party = await makeEmoticon(bob, "Party");
    await react(bob, messageId, { emoticonId: party.id });
    await react(bob, messageId, { emoticonId: party.id });
    expect(await prisma.reaction.count()).toBe(1);

    // Alice may use it too once she has saved it.
    await api.post(`/api/v1/emoticons/${party.id}/save`).set(authHeader(alice.accessToken)).send({});
    const joined = await react(alice, messageId, { emoticonId: party.id });
    expect(joined.body.message.reactions).toHaveLength(1);
    expect(joined.body.message.reactions[0]).toMatchObject({ count: 2, users: expect.arrayContaining(["alice", "bob"]) });
  });

  it("keeps an emoticon and an emoji that look the same as two separate reactions", async () => {
    const { bob, messageId } = await dmWithMessage();
    const thumbs = await makeEmoticon(bob, "Thumbs");
    await react(bob, messageId, { emoji: "👍" });
    const res = await react(bob, messageId, { emoticonId: thumbs.id });
    expect(res.body.message.reactions).toHaveLength(2);
    expect(res.body.message.reactions.map((r: { emoji?: string }) => r.emoji)).toEqual(["👍", undefined]);
  });

  it("refuses an emoticon the person cannot use: someone else's personal one, or one that does not exist", async () => {
    const { alice, bob, messageId } = await dmWithMessage();
    const private1 = await makeEmoticon(alice, "Secret");

    const notMine = await react(bob, messageId, { emoticonId: private1.id });
    expect(notMine.status).toBe(403);
    expect(notMine.body.error).toBe("emoticon_not_available");
    expect((await react(bob, messageId, { emoticonId: newProtocolId() })).status).toBe(403);
    expect(await prisma.reaction.count()).toBe(0);
  });

  it("allows an emoticon saved from someone, and one of a community the person is in, but not of a community they are not in", async () => {
    const { alice, bob, messageId } = await dmWithMessage();
    const saved = await makeEmoticon(alice, "Saved");
    await api.post(`/api/v1/emoticons/${saved.id}/save`).set(authHeader(bob.accessToken)).send({});
    expect((await react(bob, messageId, { emoticonId: saved.id })).status).toBe(200);

    const community = (await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Club" })).body.community;
    const shared = await makeEmoticon(alice, "Club", { communityId: community.id });
    expect((await react(bob, messageId, { emoticonId: shared.id })).status).toBe(403);

    const invite = await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(bob.accessToken)).send({});
    expect(invite.status).toBeLessThan(300);
    expect((await react(bob, messageId, { emoticonId: shared.id })).status).toBe(200);
  });

  it("needs exactly one of emoji and emoticonId", async () => {
    const { bob, messageId } = await dmWithMessage();
    const party = await makeEmoticon(bob, "Party");
    for (const body of [{}, { emoji: "👍", emoticonId: party.id }, { emoticonId: 5 }, { emoticonId: "" }, { emoji: "hello" }]) {
      const res = await react(bob, messageId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await prisma.reaction.count()).toBe(0);
  });

  it("takes a custom reaction back, even after losing the right to use the emoticon", async () => {
    const { alice, bob, messageId } = await dmWithMessage();
    const saved = await makeEmoticon(alice, "Saved");
    await api.post(`/api/v1/emoticons/${saved.id}/save`).set(authHeader(bob.accessToken)).send({});
    await react(bob, messageId, { emoticonId: saved.id });
    await api.delete(`/api/v1/emoticons/${saved.id}/save`).set(authHeader(bob.accessToken));
    expect((await react(bob, messageId, { emoticonId: saved.id })).status).toBe(403);

    const res = await unreact(bob, messageId, saved.id);
    expect(res.status).toBe(200);
    expect(res.body.message.reactions).toEqual([]);
    expect(await prisma.reaction.count()).toBe(0);
  });

  it("shows different emoticons as different reactions, and taking one back leaves the others", async () => {
    const { alice, bob, messageId } = await dmWithMessage();
    const party = await makeEmoticon(bob, "Party");
    const cake = await makeEmoticon(bob, "Cake");
    await api.post(`/api/v1/emoticons/${cake.id}/save`).set(authHeader(alice.accessToken)).send({});
    await react(bob, messageId, { emoticonId: party.id });
    await react(bob, messageId, { emoticonId: cake.id });
    const both = await react(alice, messageId, { emoticonId: cake.id });
    expect(both.body.message.reactions.map((r: { emoticon: { name: string } }) => [r.emoticon.name, (r as unknown as { count: number }).count])).toEqual([
      ["Party", 1],
      ["Cake", 2],
    ]);

    const res = await unreact(bob, messageId, party.id);
    expect(res.body.message.reactions.map((r: { emoticon: { name: string } }) => r.emoticon.name)).toEqual(["Cake"]);
    expect(res.body.message.reactions[0].users).toEqual(expect.arrayContaining(["alice", "bob"]));
  });

  it("removing one that is not there is harmless, and removes only the caller's own", async () => {
    const { alice, bob, messageId } = await dmWithMessage();
    const party = await makeEmoticon(bob, "Party");
    await api.post(`/api/v1/emoticons/${party.id}/save`).set(authHeader(alice.accessToken)).send({});
    await react(bob, messageId, { emoticonId: party.id });
    await react(alice, messageId, { emoticonId: party.id });

    expect((await unreact(alice, messageId, newProtocolId())).status).toBe(200);
    const res = await unreact(alice, messageId, party.id);
    expect(res.body.message.reactions).toEqual([
      { emoticon: { id: party.id, name: "Party", imageUrl: "/uploads/party.png" }, count: 1, users: ["bob"] },
    ]);
  });

  it("counts emoticons towards the 20 different reactions, and anyone can still join one that is there", async () => {
    const { alice, bob, messageId } = await dmWithMessage();
    const party = await makeEmoticon(bob, "Party");
    await api.post(`/api/v1/emoticons/${party.id}/save`).set(authHeader(alice.accessToken)).send({});
    const emoji = ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚"];
    for (const e of emoji) expect((await react(bob, messageId, { emoji: e })).status).toBe(200);
    expect((await react(bob, messageId, { emoticonId: party.id })).status).toBe(200); // the 20th kind

    const twentyFirst = await react(bob, messageId, { emoji: "😋" });
    expect(twentyFirst.status).toBe(409);
    expect(twentyFirst.body.error).toBe("too_many_reactions");

    const other = await makeEmoticon(bob, "Other");
    expect((await react(bob, messageId, { emoticonId: other.id })).body.error).toBe("too_many_reactions");
    expect((await react(alice, messageId, { emoticonId: party.id })).status).toBe(200);
  });

  it("goes when the emoticon is deleted, leaving the other reactions", async () => {
    const { alice, bob, conversationId, messageId } = await dmWithMessage();
    const party = await makeEmoticon(bob, "Party");
    await react(bob, messageId, { emoji: "👍" });
    await react(bob, messageId, { emoticonId: party.id });

    expect((await api.delete(`/api/v1/emoticons/${party.id}`).set(authHeader(bob.accessToken))).status).toBe(204);

    const seen = await api.get(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken));
    expect(seen.body.messages[0].reactions).toEqual([{ emoji: "👍", count: 1, users: ["bob"] }]);
    expect(await prisma.reaction.count({ where: { emoticonProtocolId: { not: null } } })).toBe(0);
  });

  it("follows the emoticon when its owner renames it", async () => {
    const { alice, bob, conversationId, messageId } = await dmWithMessage();
    const party = await makeEmoticon(bob, "Party");
    await react(bob, messageId, { emoticonId: party.id });
    expect((await api.patch(`/api/v1/emoticons/${party.id}`).set(authHeader(bob.accessToken)).send({ name: "Fiesta" })).status).toBe(200);

    const seen = await api.get(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken));
    expect(seen.body.messages[0].reactions[0].emoticon.name).toBe("Fiesta");
  });

  it("tells the other person's open client the same shape over the sync stream", async () => {
    const { alice, bob, messageId } = await dmWithMessage();
    const party = await makeEmoticon(bob, "Party");
    await react(bob, messageId, { emoticonId: party.id });

    const aliceRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const events = await prisma.syncEvent.findMany({ where: { recipientId: aliceRow.id, type: "message:reaction_added" } });
    expect(events).toHaveLength(1);
    expect((events[0].payload as { reactions: unknown }).reactions).toEqual([
      { emoticon: { id: party.id, name: "Party", imageUrl: "/uploads/party.png" }, count: 1, users: ["bob"] },
    ]);
  });
});

describe("a reaction is one kind or the other, in the database too", () => {
  it("refuses a row with neither an emoji nor an emoticon, and one with both", async () => {
    const { bob, messageId } = await dmWithMessage();
    const message = await prisma.message.findUniqueOrThrow({ where: { protocolId: messageId } });
    const bobRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: bob.user.id } });

    await expect(prisma.reaction.create({ data: { messageId: message.id, userId: bobRow.id } })).rejects.toThrow();
    await expect(
      prisma.reaction.create({ data: { messageId: message.id, userId: bobRow.id, emoji: "👍", emoticonProtocolId: "x" } })
    ).rejects.toThrow();
    expect(await prisma.reaction.count()).toBe(0);
  });
});

describe("custom reactions between servers", () => {
  const TEST_DOMAIN = "alice.test";
  let server: Server;
  const received: { url: string; body: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    received.length = 0;
    server = createServer((req, res) => {
      if (req.url === "/.well-known/communication-platform") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "test-key", apiBase: "" } }));
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        received.push({ url: req.url!, body: raw ? JSON.parse(raw) : {} });
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    config.federationPeerOverrides[TEST_DOMAIN] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[TEST_DOMAIN];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function dmWithRemoteAlice() {
    const bob = await registerUser("bob");
    const bobRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: bob.user.id } });
    const alice = await ensureRemoteUser({ protocolId: newProtocolId(), username: "alice", domain: TEST_DOMAIN, displayName: "Alice" });
    const conversation = await prisma.conversation.create({
      data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: bobRow.id }, { userId: alice.id }] } },
    });
    const send = await api
      .post(`/api/v1/conversations/${conversation.protocolId}/messages`)
      .set(authHeader(bob.accessToken))
      .send({ content: "hi alice" });
    await waitForPendingDeliveries();
    received.length = 0;
    return { bob, alice, conversationId: conversation.protocolId, messageId: send.body.message.id as string };
  }

  it("sends the emoticon with an absolute picture URL, and a text fallback an older server accepts", async () => {
    const { bob, messageId } = await dmWithRemoteAlice();
    const party = await makeEmoticon(bob, "Party");

    expect((await react(bob, messageId, { emoticonId: party.id })).status).toBe(200);
    await waitForPendingDeliveries();

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(`/federation/v1/messages/${messageId}/reactions`);
    expect(received[0].body).toMatchObject({
      fromDomain: config.domain,
      fromUsername: "bob",
      emoji: ":Party:",
      emoticon: { id: party.id, name: "Party", imageUrl: `${config.baseUrl}/uploads/party.png` },
    });

    received.length = 0;
    expect((await unreact(bob, messageId, party.id)).status).toBe(200);
    await waitForPendingDeliveries();
    expect(received[0].url).toBe(`/federation/v1/messages/${messageId}/reactions/remove`);
    expect(received[0].body).toMatchObject({
      emoji: ":Party:",
      emoticon: { id: party.id, name: "Party", imageUrl: `${config.baseUrl}/uploads/party.png` },
    });
  });

  it("keeps an emoticon that is already an absolute URL (S3 storage) as it is", async () => {
    const { bob, messageId } = await dmWithRemoteAlice();
    const party = await makeEmoticon(bob, "Party", { imageUrl: "https://cdn.example/party.png" });
    await react(bob, messageId, { emoticonId: party.id });
    await waitForPendingDeliveries();
    expect((received[0].body.emoticon as { imageUrl: string }).imageUrl).toBe("https://cdn.example/party.png");
  });

  describe("receiving", () => {
    async function setUp() {
      const bob = await registerUser("bob");
      const peer = await registerTestPeer("alice.test");
      const alicesProtocolId = newProtocolId();
      const conversationId = newProtocolId();
      const messageId = newProtocolId();
      await signedPost(peer, "/federation/v1/conversations", {
        conversationId,
        type: "DM",
        members: [
          { protocolId: alicesProtocolId, username: "alice", domain: "alice.test", displayName: "Alice" },
          { protocolId: bob.user.id, username: "bob", domain: "test.local", displayName: "Bob" },
        ],
      });
      await signedPost(peer, "/federation/v1/messages", {
        conversationId,
        messageId,
        fromProtocolId: alicesProtocolId,
        fromUsername: "alice",
        fromDomain: "alice.test",
        content: "from alice",
      });
      const post = (path: string, extra: Record<string, unknown>) =>
        signedPost(peer, `/federation/v1/messages/${messageId}/${path}`, {
          fromDomain: "alice.test",
          fromProtocolId: alicesProtocolId,
          fromUsername: "alice",
          ...extra,
        });
      const ref = { id: "01HZALICEPARTY0000000000AA", name: "Alicia", imageUrl: "https://alice.test/uploads/alicia.png" };
      const history = () => api.get(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(bob.accessToken));
      return { bob, post, ref, history, messageId };
    }

    it("shows an emoticon from another server from the picture it sent, without storing the emoticon", async () => {
      const { post, ref, history } = await setUp();

      expect((await post("reactions", { emoji: ":Alicia:", emoticon: ref })).status).toBe(204);

      expect(await prisma.emoticon.count()).toBe(0);
      const rows = await prisma.reaction.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ emoji: null, emoticonProtocolId: ref.id, emoticonId: null, emoticonName: "Alicia" });
      expect((await history()).body.messages[0].reactions).toEqual([{ emoticon: ref, count: 1, users: ["alice"] }]);
    });

    it("treats the emoticon as the reaction and the text fallback as only a fallback", async () => {
      const { post, ref, history } = await setUp();
      await post("reactions", { emoji: ":Alicia:", emoticon: ref });
      await post("reactions", { emoji: ":Alicia:", emoticon: ref });
      expect(await prisma.reaction.count()).toBe(1);
      expect((await history()).body.messages[0].reactions[0]).not.toHaveProperty("emoji");
    });

    it("still takes an emoji-only reaction from a server that predates custom ones", async () => {
      const { post, history } = await setUp();
      expect((await post("reactions", { emoji: "👍" })).status).toBe(204);
      expect((await history()).body.messages[0].reactions).toEqual([{ emoji: "👍", count: 1, users: ["alice"] }]);
    });

    it("removes the emoticon reaction by its id", async () => {
      const { post, ref, history } = await setUp();
      await post("reactions", { emoji: ":Alicia:", emoticon: ref });
      expect((await post("reactions/remove", { emoji: ":Alicia:", emoticon: ref })).status).toBe(204);
      expect((await history()).body.messages[0].reactions).toEqual([]);
    });

    it("refuses a picture that is not an absolute http(s) URL, or an emoticon with no name, and stores nothing", async () => {
      const { post, ref } = await setUp();
      for (const imageUrl of ["javascript:alert(1)", "data:image/png;base64,AAAA", "/uploads/alicia.png", "//alice.test/a.png"]) {
        const res = await post("reactions", { emoji: ":Alicia:", emoticon: { ...ref, imageUrl } });
        expect(res.status, imageUrl).toBe(400);
      }
      expect((await post("reactions", { emoji: ":Alicia:", emoticon: { ...ref, name: "" } })).status).toBe(400);
      expect((await post("reactions", {})).status).toBe(400);
      expect(await prisma.reaction.count()).toBe(0);
    });

    it("shows one of OUR emoticons from our own record, whatever the peer says about it, and drops it with the emoticon", async () => {
      const { bob, post, history } = await setUp();
      const ours = await makeEmoticon(bob, "Ours");

      await post("reactions", { emoji: ":Fake:", emoticon: { id: ours.id, name: "Fake", imageUrl: "https://evil.example/x.png" } });
      expect((await history()).body.messages[0].reactions).toEqual([
        { emoticon: { id: ours.id, name: "Ours", imageUrl: "/uploads/ours.png" }, count: 1, users: ["alice"] },
      ]);

      await api.delete(`/api/v1/emoticons/${ours.id}`).set(authHeader(bob.accessToken));
      expect(await prisma.reaction.count()).toBe(0);
    });
  });

  describe("in a community", () => {
    it("takes a member's custom reaction on the home server, and relays it on with the emoticon", async () => {
      const bob = await registerUser("bob");
      const community = (await api.post("/api/v1/communities").set(authHeader(bob.accessToken)).send({ name: "Club" })).body.community as {
        id: string;
        channels: { id: string }[];
      };
      const alice = await registerTestPeer("alice.test");
      // registerTestPeer caches the peer at http://alice.test; what this test needs to see is what we send BACK to it.
      await prisma.federationPeer.update({ where: { domain: "alice.test" }, data: { baseUrl: config.federationPeerOverrides[TEST_DOMAIN] } });
      await signedPost(alice, `/federation/v1/communities/${community.id}/members`, {
        protocolId: newProtocolId(),
        username: "alice",
        displayName: "Alice",
      });
      const base = `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages`;
      const sent = await signedPost(alice, base, { username: "alice", content: "react to me" });
      await waitForPendingDeliveries();
      received.length = 0;

      const ref = { id: "01HZALICEPARTY0000000000AA", name: "Alicia", imageUrl: "https://alice.test/uploads/alicia.png" };
      const res = await signedPost(alice, `${base}/${sent.body.message.id}/reactions`, { username: "alice", emoji: ":Alicia:", emoticon: ref });
      expect(res.status).toBe(200);
      expect(res.body.message.reactions).toEqual([{ emoticon: ref, count: 1, users: ["alice"] }]);

      await waitForPendingDeliveries();
      const relayed = received.filter((r) => r.url === `${base}/${sent.body.message.id}/reactions`);
      expect(relayed).toHaveLength(1);
      expect(relayed[0].body).toMatchObject({ fromUsername: "alice", emoji: ":Alicia:", emoticon: ref });

      const removed = await signedPost(alice, `${base}/${sent.body.message.id}/reactions/remove`, { username: "alice", emoticon: ref, emoji: ":Alicia:" });
      expect(removed.body.message.reactions).toEqual([]);
    });

    it("applies the REACT permission to a custom reaction as to any other", async () => {
      const bob = await registerUser("bob");
      const community = (await api.post("/api/v1/communities").set(authHeader(bob.accessToken)).send({ name: "Club" })).body.community as {
        id: string;
        channels: { id: string }[];
      };
      const mallory = await registerTestPeer("mallory.test");
      const base = `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages`;
      const ref = { id: "01HZALICEPARTY0000000000AA", name: "Alicia", imageUrl: "https://alice.test/uploads/alicia.png" };
      const res = await signedPost(mallory, `${base}/${newProtocolId()}/reactions`, { username: "mallory", emoji: ":Alicia:", emoticon: ref });
      expect(res.status).toBe(403);
      expect(await prisma.reaction.count()).toBe(0);
    });

    it("caches a custom reaction relayed from the home of a community that is elsewhere", async () => {
      const owner = await prisma.user.create({
        data: { protocolId: newProtocolId(), username: "owner", displayName: "owner", homeserverDomain: "home.invalid", isRemote: true },
      });
      const stub = await prisma.community.create({
        data: { protocolId: newProtocolId(), name: "Remote Community", ownerId: owner.id, homeserverDomain: "home.invalid", isRemote: true },
      });
      const channel = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: stub.id, name: "general", position: 0 } });
      const home = await registerTestPeer("home.invalid");
      const base = `/federation/v1/communities/${stub.protocolId}/channels/${channel.protocolId}/messages`;
      const messageId = newProtocolId();
      await signedPost(home, base, {
        messageId,
        fromProtocolId: owner.protocolId,
        fromUsername: "owner",
        fromDomain: "home.invalid",
        content: "hello from home",
      });

      const ref = { id: "01HZALICEPARTY0000000000AA", name: "Alicia", imageUrl: "https://alice.test/uploads/alicia.png" };
      const reactor = { fromDomain: "home.invalid", fromProtocolId: owner.protocolId, fromUsername: "owner" };
      expect((await signedPost(home, `${base}/${messageId}/reactions`, { ...reactor, emoji: ":Alicia:", emoticon: ref })).status).toBe(204);
      const stored = await prisma.reaction.findMany({ where: { message: { protocolId: messageId } } });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ emoticonProtocolId: ref.id, emoticonName: "Alicia", emoticonImageUrl: ref.imageUrl });

      expect((await signedPost(home, `${base}/${messageId}/reactions/remove`, { ...reactor, emoji: ":Alicia:", emoticon: ref })).status).toBe(204);
      expect(await prisma.reaction.count()).toBe(0);
    });
  });
});
