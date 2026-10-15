// FEDERATION_ENABLED=false (#109, phase 1): a private server. It says so in its discovery document, refuses every
// federation request unprocessed, sends nothing and retries nothing, starts no relationship with anyone on another
// server, and keeps what already exists so that turning federation back on restores it with nothing lost.
//
// config.federationEnabled is read at the moment of each decision (never cached), so these tests flip it per test and
// put it back, the same way they point federationPeerOverrides at a fake peer.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { flushOutboxForDomain, processDueOutboxEvents, waitForPendingDeliveries } from "../../src/lib/federation/outbox.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);
afterEach(() => {
  config.federationEnabled = true;
});

type Registered = Awaited<ReturnType<typeof registerUser>>;

const PEER = "far.invalid";
let peer: Server;
/** Every request that reached the fake peer, in order. A private server must add nothing to this. */
let received: { method: string; url: string }[];
/** What the fake peer does with federation calls: normal, `private` (403 federation_disabled) or `rejects` (403 forbidden). */
let peerAnswers: { private: boolean; rejects: boolean };

beforeEach(async () => {
  received = [];
  peerAnswers = { private: false, rejects: false };
  peer = createServer((req, res) => {
    received.push({ method: req.method ?? "", url: req.url ?? "" });
    res.setHeader("Content-Type", "application/json");
    // The peer has gone private: it refuses every federation call. (Its discovery document is left as cached.)
    if (peerAnswers.private && req.url?.startsWith("/federation/v1/")) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "federation_disabled" }));
      return;
    }
    if (peerAnswers.rejects && req.url?.startsWith("/federation/v1/")) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    if (req.url === "/.well-known/communication-platform") {
      res.end(JSON.stringify({ federation: { enabled: true, publicKey: `${PEER}-key`, apiBase: "/federation/v1" } }));
      return;
    }
    if (req.url?.split("?")[0] === "/federation/v1/users/dave") {
      res.end(JSON.stringify({ user: { id: "dave-protocol-id", username: "dave", displayName: "Dave", avatarUrl: null, bio: "Hello" } }));
      return;
    }
    res.statusCode = 201;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  config.federationPeerOverrides[PEER] = `http://127.0.0.1:${(peer.address() as { port: number }).port}`;
});

afterEach(async () => {
  delete config.federationPeerOverrides[PEER];
  await new Promise<void>((resolve) => peer.close(() => resolve()));
});

const makePrivate = () => {
  config.federationEnabled = false;
};
const makePublic = () => {
  config.federationEnabled = true;
};
const hits = () => received.length;
const outboxRows = () => prisma.federationOutboxEvent.findMany({ orderBy: { createdAt: "asc" } });

/** A person on the fake peer who is already alice's friend, with a direct message open: an existing remote relationship. */
async function withRemoteFriend(alice: Registered) {
  const created = await api
    .post("/api/v1/conversations")
    .set(authHeader(alice.accessToken))
    .send({ type: "DM", memberUsernames: [`dave:${PEER}`] });
  expect([200, 201]).toContain(created.status);
  await waitForPendingDeliveries();
  const aliceRow = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
  const dave = await prisma.user.findFirstOrThrow({ where: { username: "dave", homeserverDomain: PEER } });
  await prisma.friendship.createMany({
    data: [
      { userId: aliceRow.id, friendId: dave.id },
      { userId: dave.id, friendId: aliceRow.id },
    ],
  });
  await prisma.federationOutboxEvent.deleteMany({}); // what was queued while setting this up is not what is under test
  received.length = 0;
  return { conversationId: created.body.conversation.id as string, dave };
}

describe("the discovery document", () => {
  it("advertises federation, with where to reach it and the signing key, by default", async () => {
    const res = await api.get("/.well-known/communication-platform");

    expect(res.status).toBe(200);
    expect(res.body.features.federation).toBe(true);
    expect(res.body.federation).toMatchObject({ enabled: true, apiBase: "/federation/v1" });
    expect(res.body.federation.publicKey).toContain("BEGIN PUBLIC KEY");
  });

  it("says a private server is not federating, and offers nothing to connect to", async () => {
    makePrivate();

    const res = await api.get("/.well-known/communication-platform");

    expect(res.status).toBe(200);
    expect(res.body.features.federation).toBe(false);
    expect(res.body.federation).toEqual({ enabled: false });
    expect(JSON.stringify(res.body)).not.toContain("PUBLIC KEY");
  });

  // The client's server picker reads this document from a domain someone just typed, so it must stay public and complete.
  it("still tells a client everything else it needs, and stays readable from any origin", async () => {
    makePrivate();

    const res = await api.get("/.well-known/communication-platform").set("Origin", "https://anywhere.example");

    expect(res.body).toMatchObject({ domain: config.domain, apiBase: "/api/v1", websocketPath: "/ws", registration: { enabled: expect.any(Boolean) } });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("is what another server reads to decide it cannot federate with this one", async () => {
    makePrivate();
    const doc = (await api.get("/.well-known/communication-platform")).body;

    // discovery.ts refuses a peer whose document lacks enabled: true and a key.
    expect(!doc.federation?.enabled || !doc.federation?.publicKey).toBe(true);
  });
});

describe("answering other servers", () => {
  it("works as ever by default: a signed request is processed", async () => {
    await registerUser("bob");
    const caller = await registerTestPeer("alice.test");

    const res = await signedPost(caller, "/federation/v1/communities/none/members", { protocolId: newProtocolId(), username: "x" });

    expect(res.status).toBe(404); // reached the route, which found no such community
  });

  it("refuses every federation endpoint, with the same answer, whatever the request", async () => {
    await registerUser("bob");
    const caller = await registerTestPeer("alice.test");
    makePrivate();

    const paths = [
      "/federation/v1/users/bob",
      "/federation/v1/friend-requests",
      "/federation/v1/conversations",
      "/federation/v1/messages",
      "/federation/v1/presence",
      "/federation/v1/communities/x/members",
      "/federation/v1/communities/x/invites",
      "/federation/v1/communities/x/updated",
    ];
    for (const path of paths) {
      const res = await signedPost(caller, path, {});
      expect([res.status, res.body], path).toEqual([403, { error: "federation_disabled" }]);
    }
  });

  it("gives the same answer to a request that is not signed, wrongly signed or from nobody known, so it reveals nothing about who is asking", async () => {
    makePrivate();

    const unsigned = await api.post("/federation/v1/messages").send({});
    const forged = await api
      .post("/federation/v1/messages")
      .set("X-Federation-Origin", "never-seen.invalid")
      .set("X-Federation-Timestamp", String(Date.now()))
      .set("X-Federation-Signature", "not-a-signature")
      .send({});
    const get = await api.get("/federation/v1/users/bob");

    for (const res of [unsigned, forged, get]) expect([res.status, res.body]).toEqual([403, { error: "federation_disabled" }]);
  });

  // Nothing is processed: no signature check (which would fetch the caller's discovery document), no nonce, no peer cached.
  it("does nothing with a request: it looks nobody up, records no nonce and caches no peer", async () => {
    makePrivate();
    const peersBefore = await prisma.federationPeer.count();

    await api
      .post("/federation/v1/messages")
      .set("X-Federation-Origin", PEER)
      .set("X-Federation-Timestamp", String(Date.now()))
      .set("X-Federation-Signature", "x")
      .send({});

    expect(received).toEqual([]); // it did not even go and read the caller's .well-known
    expect(await prisma.federationPeer.count()).toBe(peersBefore);
  });

  it("answers again as soon as federation is back on", async () => {
    await registerUser("bob");
    const caller = await registerTestPeer("alice.test");
    makePrivate();
    expect((await signedPost(caller, "/federation/v1/communities/none/members", {})).status).toBe(403);

    makePublic();

    expect((await signedPost(caller, "/federation/v1/communities/none/members", { protocolId: newProtocolId(), username: "x" })).status).toBe(404);
  });

  it("leaves the ordinary API alone", async () => {
    makePrivate();
    const alice = await registerUser("alice");

    expect((await api.get("/api/v1/users/me").set(authHeader(alice.accessToken))).status).toBe(200);
    expect((await api.get("/healthz")).status).toBe(200);
  });
});

describe("starting a relationship with someone on another server", () => {
  it("is refused plainly when adding a friend there, and nothing is looked up or stored", async () => {
    const alice = await registerUser("alice");
    makePrivate();

    const res = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: `dave:${PEER}` });

    expect([res.status, res.body.error]).toEqual([403, "federation_disabled"]); // not user_not_found, which would be untrue
    expect(received).toEqual([]);
    expect(await prisma.user.count({ where: { isRemote: true } })).toBe(0);
    expect(await prisma.friendRequest.count()).toBe(0);
  });

  it("is refused when starting a direct message or group with someone there", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    makePrivate();

    const dm = await api.post("/api/v1/conversations").set(authHeader(alice.accessToken)).send({ type: "DM", memberUsernames: [`dave:${PEER}`] });
    const group = await api
      .post("/api/v1/conversations")
      .set(authHeader(alice.accessToken))
      .send({ type: "GROUP", memberUsernames: ["bob", `dave:${PEER}`], title: "Mixed" });

    expect([dm.status, dm.body.error]).toEqual([403, "federation_disabled"]);
    expect([group.status, group.body.error]).toEqual([403, "federation_disabled"]);
    expect(received).toEqual([]);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("is refused when joining a community on another server, with nothing cached", async () => {
    const alice = await registerUser("alice");
    makePrivate();

    const res = await api.post(`/api/v1/communities/${encodeURIComponent(`REMOTECOMM01:${PEER}#K7M2QXR9TB`)}/members`).set(authHeader(alice.accessToken)).send({});

    expect([res.status, res.body.error]).toEqual([403, "federation_disabled"]);
    expect(received).toEqual([]);
    expect(await prisma.community.count()).toBe(0);
  });

  it("still lets people on this server do all of it with each other", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    makePrivate();

    const friend = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "bob" });
    expect(friend.status).toBe(201);
    await api.post(`/api/v1/friends/requests/${friend.body.request.id}/accept`).set(authHeader(bob.accessToken));
    const dm = await api.post("/api/v1/conversations").set(authHeader(alice.accessToken)).send({ type: "DM", memberUsernames: ["bob"] });
    expect([200, 201]).toContain(dm.status);
    const community = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Home" });
    expect(community.status).toBe(201);
    const joined = await api.post(`/api/v1/communities/${community.body.community.id}/members`).set(authHeader(bob.accessToken)).send({});
    expect(joined.status).toBe(201);
    expect(received).toEqual([]);
  });

  it("works exactly as before when federation is on", async () => {
    const alice = await registerUser("alice");

    const res = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: `dave:${PEER}` });

    expect(res.status).toBe(201);
    expect(received.some((r) => r.url.startsWith("/federation/v1/users/dave"))).toBe(true);
  });
});

describe("what already exists with other servers", () => {
  it("is kept: nothing is deleted by going private and back", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    const before = {
      users: await prisma.user.count({ where: { isRemote: true } }),
      friendships: await prisma.friendship.count(),
      conversations: await prisma.conversation.count(),
      members: await prisma.conversationMember.count(),
    };

    makePrivate();
    await api.get("/api/v1/friends").set(authHeader(alice.accessToken));
    await api.get(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken));
    makePublic();

    expect({
      users: await prisma.user.count({ where: { isRemote: true } }),
      friendships: await prisma.friendship.count(),
      conversations: await prisma.conversation.count(),
      members: await prisma.conversationMember.count(),
    }).toEqual(before);
  });

  it("can still be read: the friend, the conversation and its history are there on a private server", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    makePrivate();

    const friends = await api.get("/api/v1/friends").set(authHeader(alice.accessToken));
    const history = await api.get(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken));
    const list = await api.get("/api/v1/conversations").set(authHeader(alice.accessToken));

    expect(friends.body.friends.map((f: { username: string }) => f.username)).toEqual(["dave"]);
    expect(history.status).toBe(200);
    expect(list.body.conversations.map((c: { id: string }) => c.id)).toContain(conversationId);
    expect(received).toEqual([]);
  });

  it("shows a remote person's profile from what is cached, as unreachable, without asking their server", async () => {
    const alice = await registerUser("alice");
    const { dave } = await withRemoteFriend(alice);
    makePrivate();

    const res = await api.get(`/api/v1/users/${dave.protocolId}/profile`).set(authHeader(alice.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.profile.homeServerReachable).toBe(false);
    expect(res.body.profile.user.displayName).toBe("Dave");
    expect(received).toEqual([]);
  });

  it("refuses what needs the other server's say-so: an invite or a message in a community hosted there", async () => {
    const alice = await registerUser("alice");
    const owner = await prisma.user.create({
      data: { protocolId: newProtocolId(), username: "olga", displayName: "Olga", homeserverDomain: PEER, isRemote: true },
    });
    const community = await prisma.community.create({
      data: { protocolId: newProtocolId(), name: "Far Club", ownerId: owner.id, homeserverDomain: PEER, isRemote: true },
    });
    const aliceRow = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    await prisma.communityMember.create({ data: { communityId: community.id, userId: aliceRow.id } });
    const channel = await prisma.channel.create({
      data: { protocolId: newProtocolId(), communityId: community.id, name: "general", position: 0 },
    });
    makePrivate();

    const invite = await api.post(`/api/v1/communities/${community.protocolId}/invites`).set(authHeader(alice.accessToken)).send({});
    const message = await api
      .post(`/api/v1/channels/${channel.protocolId}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "hello" });

    expect([invite.status, invite.body.error]).toEqual([403, "federation_disabled"]);
    expect([message.status, message.body.error]).toEqual([403, "federation_disabled"]);
    expect(received).toEqual([]);
  });
});

describe("sending nothing and retrying nothing", () => {
  it("keeps what people do that concerns another server, undelivered and uncounted, instead of sending it", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    makePrivate();

    const sent = await api
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "are you there?" });
    await waitForPendingDeliveries();

    expect(sent.status).toBe(201); // stored here
    expect(received).toEqual([]);
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: PEER, path: "/messages", status: "PENDING", attempts: 0 });
  });

  it("does not deliver it on the worker's pass, or a flush, nor count either as an attempt", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    makePrivate();
    await api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello" });
    await waitForPendingDeliveries();
    const before = (await outboxRows())[0];

    await processDueOutboxEvents();
    await flushOutboxForDomain(PEER);
    await processDueOutboxEvents();

    expect(received).toEqual([]);
    const after = (await outboxRows())[0];
    expect(after).toMatchObject({ status: "PENDING", attempts: 0, lastError: null });
    expect(after.nextAttemptAt).toEqual(before.nextAttemptAt);
  });

  it("tells no other server about a change of status", async () => {
    const alice = await registerUser("alice");
    await withRemoteFriend(alice);
    makePrivate();

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await api.patch("/api/v1/users/me/presence").set(authHeader(alice.accessToken)).send({ status: "BUSY" });
    await waitForPendingDeliveries();

    expect(res.status).toBe(200);
    expect(received).toEqual([]);
    // ...and it does not fill the log with a failure for every friend on another server each time anyone changes status.
    expect(errors.mock.calls.filter((call) => String(call[0]).includes("presence push"))).toEqual([]);
    errors.mockRestore();
  });

  it("tells them again when federation is on", async () => {
    const alice = await registerUser("alice");
    await withRemoteFriend(alice);

    await api.patch("/api/v1/users/me/presence").set(authHeader(alice.accessToken)).send({ status: "BUSY" });

    expect(received.some((r) => r.url === "/federation/v1/presence")).toBe(true);
  });

  it("delivers everything that was held, in order, once federation is back on, so nothing is lost", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    makePrivate();
    for (const content of ["one", "two", "three"]) {
      await api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken)).send({ content });
    }
    await waitForPendingDeliveries();
    expect(received).toEqual([]);
    expect(await outboxRows()).toHaveLength(3);

    makePublic();
    await processDueOutboxEvents();

    const delivered = received.filter((r) => r.url === "/federation/v1/messages");
    expect(delivered).toHaveLength(3);
    expect(await outboxRows()).toHaveLength(0);
  });
});

// The other side of it: this server federates, but a server it talks to has gone private (it answers every federation call
// 403 federation_disabled). That is a state of the other server, not a verdict on what was sent.
describe("a peer that has gone private", () => {
  it("keeps what was meant for it, to try again, rather than recording it as rejected and losing it for good", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    peerAnswers.private = true;

    await api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello?" });
    await waitForPendingDeliveries();

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PENDING", attempts: 1, lastError: "peer_federation_disabled" });
    expect(rows[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("delivers it once the peer federates again", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    peerAnswers.private = true;
    await api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello?" });
    await waitForPendingDeliveries();
    peerAnswers.private = false;
    await prisma.federationOutboxEvent.updateMany({ data: { nextAttemptAt: new Date() } });
    received.length = 0;

    await processDueOutboxEvents();

    expect(received.filter((r) => r.url === "/federation/v1/messages")).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("still treats an ordinary refusal as final, as before", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    peerAnswers.rejects = true;

    await api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello?" });
    await waitForPendingDeliveries();

    const rows = await outboxRows();
    expect(rows[0]).toMatchObject({ status: "FAILED", lastError: "http_403" });
  });

  it("is reported to your own people as a server that could not be reached, not as this server being private", async () => {
    const alice = await registerUser("alice");
    const owner = await prisma.user.create({
      data: { protocolId: newProtocolId(), username: "olga", displayName: "Olga", homeserverDomain: PEER, isRemote: true },
    });
    const community = await prisma.community.create({
      data: { protocolId: newProtocolId(), name: "Far Club", ownerId: owner.id, homeserverDomain: PEER, isRemote: true },
    });
    const aliceRow = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    await prisma.communityMember.create({ data: { communityId: community.id, userId: aliceRow.id } });
    const channel = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: community.id, name: "general", position: 0 } });
    // The peer's own discovery is cached (a peer is only looked up every ten minutes), so the call goes out and is refused.
    await prisma.federationPeer.create({ data: { domain: PEER, baseUrl: config.federationPeerOverrides[PEER], publicKey: `${PEER}-key` } });
    peerAnswers.private = true;

    const res = await api.post(`/api/v1/channels/${channel.protocolId}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello" });

    expect([res.status, res.body.error]).toEqual([502, "federation_unreachable"]);
  });
});
