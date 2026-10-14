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

const TEST_DOMAIN = "alice.test";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("message edit/delete/reactions (local, no federation)", () => {
  async function sendMessage(token: string, conversationId: string, content = "hello") {
    const res = await api
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(authHeader(token))
      .send({ content });
    expect(res.status).toBe(201);
    return res.body.message as { id: string };
  }

  async function dmBetween(aliceToken: string, bobUsername: string) {
    const res = await api
      .post("/api/v1/conversations")
      .set(authHeader(aliceToken))
      .send({ type: "DM", memberUsernames: [bobUsername] });
    expect(res.status).toBe(201);
    return res.body.conversation.id as string;
  }

  it("lets the sender edit their own message", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const conversationId = await dmBetween(alice.accessToken, bob.user.username);
    const message = await sendMessage(alice.accessToken, conversationId);

    const res = await api
      .patch(`/api/v1/messages/${message.id}`)
      .set(authHeader(alice.accessToken))
      .send({ content: "edited" });
    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe("edited");
    expect(res.body.message.editedAt).not.toBeNull();
  });

  it("forbids editing someone else's message", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const conversationId = await dmBetween(alice.accessToken, bob.user.username);
    const message = await sendMessage(alice.accessToken, conversationId);

    const res = await api
      .patch(`/api/v1/messages/${message.id}`)
      .set(authHeader(bob.accessToken))
      .send({ content: "hijacked" });
    expect(res.status).toBe(403);
  });

  it("lets the sender delete their own message, clearing content but not the row", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const conversationId = await dmBetween(alice.accessToken, bob.user.username);
    const message = await sendMessage(alice.accessToken, conversationId);

    const res = await api.delete(`/api/v1/messages/${message.id}`).set(authHeader(alice.accessToken));
    expect(res.status).toBe(204);

    const row = await prisma.message.findUnique({ where: { protocolId: message.id } });
    expect(row!.deletedAt).not.toBeNull();
  });

  it("lets any conversation member react, and the other member un-react separately", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const conversationId = await dmBetween(alice.accessToken, bob.user.username);
    const message = await sendMessage(alice.accessToken, conversationId);

    const react = await api
      .post(`/api/v1/messages/${message.id}/reactions`)
      .set(authHeader(bob.accessToken))
      .send({ emoji: "👍" });
    expect(react.status).toBe(200);
    expect(react.body.message.reactions).toEqual([{ emoji: "👍", count: 1, users: ["bob"] }]);

    const unreact = await api
      .delete(`/api/v1/messages/${message.id}/reactions/%F0%9F%91%8D`)
      .set(authHeader(bob.accessToken));
    expect(unreact.status).toBe(200);
    expect(unreact.body.message.reactions).toEqual([]);
  });

  it("accepts any single emoji as a reaction: ZWJ sequences, skin tones, flags and keycaps included", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const conversationId = await dmBetween(alice.accessToken, bob.user.username);
    const message = await sendMessage(alice.accessToken, conversationId);

    for (const emoji of ["🚀", "👍🏽", "👨‍👩‍👧‍👦", "🇳🇿", "1️⃣"]) {
      const res = await api.post(`/api/v1/messages/${message.id}/reactions`).set(authHeader(bob.accessToken)).send({ emoji });
      expect(res.status).toBe(200);
    }
  });

  // Before this rule the API took any 1-32 character string, so "hello" was a valid reaction.
  it("rejects a reaction that is not exactly one emoji", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const conversationId = await dmBetween(alice.accessToken, bob.user.username);
    const message = await sendMessage(alice.accessToken, conversationId);

    for (const emoji of ["hello", "a", "😀😀", "😀a", ":party:", "", "<b>😀</b>"]) {
      const res = await api.post(`/api/v1/messages/${message.id}/reactions`).set(authHeader(bob.accessToken)).send({ emoji });
      expect(res.status, JSON.stringify(emoji)).toBe(400);
    }
    expect(await prisma.reaction.count()).toBe(0);
  });

  it("still lets someone take back an old reaction that is not an emoji", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const conversationId = await dmBetween(alice.accessToken, bob.user.username);
    const message = await sendMessage(alice.accessToken, conversationId);
    const row = await prisma.message.findUniqueOrThrow({ where: { protocolId: message.id } });
    const bobRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: bob.user.id } });
    await prisma.reaction.create({ data: { messageId: row.id, userId: bobRow.id, emoji: "hello" } });

    const res = await api.delete(`/api/v1/messages/${message.id}/reactions/hello`).set(authHeader(bob.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.message.reactions).toEqual([]);
  });

  // The emoji picker's dataset spells thumbs-up with a trailing variation selector, the quick reaction
  // doesn't; unless they are one reaction you get two identical-looking pills.
  it("treats both spellings of an emoji as the same reaction, and either removes it", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const conversationId = await dmBetween(alice.accessToken, bob.user.username);
    const message = await sendMessage(alice.accessToken, conversationId);
    const withSelector = "👍" + String.fromCharCode(0xfe0f);

    await api.post(`/api/v1/messages/${message.id}/reactions`).set(authHeader(alice.accessToken)).send({ emoji: "👍" });
    const second = await api
      .post(`/api/v1/messages/${message.id}/reactions`)
      .set(authHeader(bob.accessToken))
      .send({ emoji: withSelector });

    expect(second.body.message.reactions).toEqual([{ emoji: "👍", count: 2, users: expect.arrayContaining(["alice", "bob"]) }]);

    const removed = await api
      .delete(`/api/v1/messages/${message.id}/reactions/${encodeURIComponent(withSelector)}`)
      .set(authHeader(bob.accessToken));
    expect(removed.body.message.reactions).toEqual([{ emoji: "👍", count: 1, users: ["alice"] }]);
  });

  it("caps a message at 20 different reactions, while anyone can still join one that is already there", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const conversationId = await dmBetween(alice.accessToken, bob.user.username);
    const message = await sendMessage(alice.accessToken, conversationId);
    // 20 distinct emoji from the Emoticons block.
    const emoji = Array.from({ length: 21 }, (_, i) => String.fromCodePoint(0x1f600 + i));

    for (const e of emoji.slice(0, 20)) {
      const res = await api.post(`/api/v1/messages/${message.id}/reactions`).set(authHeader(bob.accessToken)).send({ emoji: e });
      expect(res.status).toBe(200);
    }

    const twentyFirst = await api
      .post(`/api/v1/messages/${message.id}/reactions`)
      .set(authHeader(bob.accessToken))
      .send({ emoji: emoji[20] });
    expect(twentyFirst.status).toBe(409);
    expect(twentyFirst.body.error).toBe("too_many_reactions");

    const join = await api
      .post(`/api/v1/messages/${message.id}/reactions`)
      .set(authHeader(alice.accessToken))
      .send({ emoji: emoji[0] });
    expect(join.status).toBe(200);
    expect(join.body.message.reactions.find((r: { emoji: string }) => r.emoji === emoji[0]).count).toBe(2);
  });
});

describe("message edit/delete/reactions (federated DM, real outbound relay)", () => {
  let server: Server;
  let port: number;
  const received: { method: string; url: string; body: unknown }[] = [];

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
        received.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : {} });
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    config.federationPeerOverrides[TEST_DOMAIN] = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[TEST_DOMAIN];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function setUpFederatedDm() {
    const bob = await registerUser("bob");
    // registerUser()'s own user.id is the protocolId (serialized shape),
    // not the local DB id ConversationMember.userId actually references -
    // needs its own lookup.
    const bobDbUser = await prisma.user.findUniqueOrThrow({ where: { protocolId: bob.user.id } });
    const alice = await ensureRemoteUser({
      protocolId: newProtocolId(),
      username: "alice",
      domain: TEST_DOMAIN,
      displayName: "Alice",
    });
    const conversation = await prisma.conversation.create({
      data: {
        protocolId: newProtocolId(),
        type: "DM",
        members: { create: [{ userId: bobDbUser.id }, { userId: alice.id }] },
      },
    });
    return { bob, conversationId: conversation.protocolId };
  }

  it("relays a local edit to the remote member's homeserver", async () => {
    const { bob, conversationId } = await setUpFederatedDm();
    const sendRes = await api
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(authHeader(bob.accessToken))
      .send({ content: "hello alice" });
    const messageId = sendRes.body.message.id as string;
    await waitForPendingDeliveries(); // the send's own relay is delivered in the background: let it land first
    received.length = 0; // only care about what the edit itself sends

    const res = await api
      .patch(`/api/v1/messages/${messageId}`)
      .set(authHeader(bob.accessToken))
      .send({ content: "hello alice, edited" });
    expect(res.status).toBe(200);
    await waitForPendingDeliveries(); // delivery to the peer happens after the response

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(`/federation/v1/messages/${messageId}/edit`);
    expect(received[0].body).toEqual({ content: "hello alice, edited" });
  });

  it("relays a local delete to the remote member's homeserver", async () => {
    const { bob, conversationId } = await setUpFederatedDm();
    const sendRes = await api
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(authHeader(bob.accessToken))
      .send({ content: "hello alice" });
    const messageId = sendRes.body.message.id as string;
    await waitForPendingDeliveries();
    received.length = 0;

    const res = await api.delete(`/api/v1/messages/${messageId}`).set(authHeader(bob.accessToken));
    expect(res.status).toBe(204);
    await waitForPendingDeliveries();

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(`/federation/v1/messages/${messageId}/delete`);
  });

  it("relays a local reaction (and its removal) to the remote member's homeserver, carrying the reactor's identity", async () => {
    const { bob, conversationId } = await setUpFederatedDm();
    const sendRes = await api
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(authHeader(bob.accessToken))
      .send({ content: "hello alice" });
    const messageId = sendRes.body.message.id as string;
    await waitForPendingDeliveries();
    received.length = 0;

    const react = await api
      .post(`/api/v1/messages/${messageId}/reactions`)
      .set(authHeader(bob.accessToken))
      .send({ emoji: "🎉" });
    expect(react.status).toBe(200);
    await waitForPendingDeliveries();

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(`/federation/v1/messages/${messageId}/reactions`);
    expect(received[0].body).toMatchObject({
      fromDomain: config.domain,
      fromUsername: "bob",
      emoji: "🎉",
    });

    received.length = 0;
    const unreact = await api
      .delete(`/api/v1/messages/${messageId}/reactions/%F0%9F%8E%89`)
      .set(authHeader(bob.accessToken));
    expect(unreact.status).toBe(200);
    await waitForPendingDeliveries();

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(`/federation/v1/messages/${messageId}/reactions/remove`);
    expect(received[0].body).toMatchObject({ fromDomain: config.domain, fromUsername: "bob", emoji: "🎉" });
  });
});
