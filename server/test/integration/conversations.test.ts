import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

async function createDm(token: string, memberUsernames: string[]) {
  const res = await api
    .post("/api/v1/conversations")
    .set(authHeader(token))
    .send({ type: "DM", memberUsernames });
  return res;
}

describe("DM conversations", () => {
  it("creates a DM between two members", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");

    const res = await createDm(alice.accessToken, ["bob"]);
    expect(res.status).toBe(201);
    expect(res.body.conversation.type).toBe("DM");
    expect(res.body.conversation.members.map((m: { username: string }) => m.username).sort()).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("is idempotent - creating the same pair's DM twice returns the same conversation", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");

    const first = await createDm(alice.accessToken, ["bob"]);
    const second = await createDm(alice.accessToken, ["bob"]);

    expect(second.status).toBe(200);
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
  });

  it("refuses a block'd pair", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await api.post("/api/v1/friends/blocks").set(authHeader(alice.accessToken)).send({ username: "bob" });

    const res = await createDm(bob.accessToken, ["alice"]);
    expect(res.status).toBe(403);
  });

  it("sends and fetches messages in order", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const convo = await createDm(alice.accessToken, ["bob"]);

    await api
      .post(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "hello" });
    await api
      .post(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "world" });

    const fetched = await api
      .get(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken));
    expect(fetched.body.messages.map((m: { content: string }) => m.content)).toEqual(["hello", "world"]);
  });

  it("a non-member cannot read or post messages", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const eve = await registerUser("eve");
    const convo = await createDm(alice.accessToken, ["bob"]);

    const readRes = await api
      .get(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(eve.accessToken));
    expect(readRes.status).toBe(404);

    const postRes = await api
      .post(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(eve.accessToken))
      .send({ content: "sneaky" });
    expect(postRes.status).toBe(404);
  });
});

// A group DM naming remote members on *different* domains is a new,
// previously-impossible scenario (the receiving side used to hard-reject
// anything but one remote domain) - this exercises the already-written
// per-domain fan-out loop (conversations/routes.ts) end to end for the
// first time with a genuinely multi-domain member set. Two real local HTTP
// servers stand in for two separate remote homeservers (same pattern as
// federationOutbox.test.ts/ssrfGuard.integration.test.ts) - each needs to
// answer GET /federation/v1/users/:username for resolveOrFetchUser to
// succeed during creation; neither needs to implement POST /conversations
// itself, since a failed delivery attempt leaving a row behind is exactly
// what this test wants to assert against.
describe("GROUP conversations spanning multiple federated domains", () => {
  const domains = ["group-a.invalid", "group-b.invalid"];
  const servers: Server[] = [];

  beforeEach(async () => {
    for (const domain of domains) {
      const username = domain.split(".")[0] === "group-a" ? "dave" : "erin";
      const server = createServer((req, res) => {
        if (req.url === "/.well-known/communication-platform") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ federation: { enabled: true, publicKey: `${domain}-key`, apiBase: "/federation/v1" } }));
          return;
        }
        if (req.url === `/federation/v1/users/${username}`) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ user: { id: `${username}-protocol-id`, username, displayName: username, avatarUrl: null } }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      config.federationPeerOverrides[domain] = `http://127.0.0.1:${port}`;
      servers.push(server);
    }
  });

  afterEach(async () => {
    for (const domain of domains) delete config.federationPeerOverrides[domain];
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  it("enqueues a separate federation outbox event per distinct remote domain", async () => {
    const alice = await registerUser("alice");

    const res = await api
      .post("/api/v1/conversations")
      .set(authHeader(alice.accessToken))
      .send({ type: "GROUP", memberUsernames: ["dave:group-a.invalid", "erin:group-b.invalid"] });

    expect(res.status).toBe(201);
    const rows = await prisma.federationOutboxEvent.findMany({ where: { path: "/conversations" } });
    expect(rows.map((r) => r.domain).sort()).toEqual(domains.slice().sort());
  });
});

describe("group conversation member cap", () => {
  it("rejects creating a conversation with more members than the cap allows", async () => {
    const alice = await registerUser("alice");
    const others = await Promise.all(Array.from({ length: 10 }, (_, i) => registerUser(`member${i}`)));

    const res = await api
      .post("/api/v1/conversations")
      .set(authHeader(alice.accessToken))
      .send({ type: "GROUP", memberUsernames: others.map((o) => o.user.username) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});

// Regression test for a real bug found during manual testing: community
// channel messages were briefly showing up inside an unrelated DM thread (and
// vice versa) because the realtime event for a new message didn't originally
// carry its conversationId/channelId, so the client had nothing to filter
// on. The fix was to always include that location on every message-related
// sync event. This asserts the fixed wire format at the source: the
// SyncEvent payload delivered via GET /api/v1/sync.
describe("message isolation between a DM and a community channel (regression)", () => {
  it("fetching one thread's messages never includes the other's, and sync events carry the correct location", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");

    const convo = await createDm(alice.accessToken, ["bob"]);
    const community = await api
      .post("/api/v1/communities")
      .set(authHeader(alice.accessToken))
      .send({ name: "Test Community" });
    const channelId = community.body.community.channels[0].id;
    await api
      .post(`/api/v1/communities/${community.body.community.id}/members`)
      .set(authHeader(bob.accessToken));

    await api
      .post(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "dm message" });
    await api
      .post(`/api/v1/channels/${channelId}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "channel message" });

    const dmMessages = await api
      .get(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken));
    expect(dmMessages.body.messages.map((m: { content: string }) => m.content)).toEqual(["dm message"]);

    const channelMessages = await api
      .get(`/api/v1/channels/${channelId}/messages`)
      .set(authHeader(alice.accessToken));
    expect(channelMessages.body.messages.map((m: { content: string }) => m.content)).toEqual(["channel message"]);

    // Bob is a member of both the DM and the community, so both events land
    // in his sync outbox - each must be tagged with the thread it belongs to.
    const sync = await api.get("/api/v1/sync?cursor=0").set(authHeader(bob.accessToken));
    const messageEvents = sync.body.events.filter((e: { type: string }) => e.type === "message:created");
    expect(messageEvents).toHaveLength(2);

    const dmEvent = messageEvents.find((e: any) => e.payload.message.content === "dm message");
    expect(dmEvent.payload.conversationId).toBe(convo.body.conversation.id);
    expect(dmEvent.payload.channelId).toBeUndefined();

    const channelEvent = messageEvents.find((e: any) => e.payload.message.content === "channel message");
    expect(channelEvent.payload.channelId).toBe(channelId);
    expect(channelEvent.payload.conversationId).toBeUndefined();
  });
});
