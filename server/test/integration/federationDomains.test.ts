// FEDERATION_ALLOWED_DOMAINS / FEDERATION_BLOCKED_DOMAINS (#109, phase 2): the servers this one will talk to. A server that
// is not permitted is neither answered nor contacted, nothing new starts with it, and what already exists with it is kept
// and waits (delivered, in order, if the lists change), as on a private server - but only toward that server.
//
// config.federationPolicy is read at the moment of each decision, so these tests swap it per test and put it back.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { createDomainPolicy } from "../../src/lib/federationPolicy.js";
import { flushOutboxForDomain, processDueOutboxEvents, waitForPendingDeliveries } from "../../src/lib/federation/outbox.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);
afterEach(() => {
  config.federationEnabled = true;
  config.federationPolicy = createDomainPolicy([], []);
});

type Registered = Awaited<ReturnType<typeof registerUser>>;

const PEER = "far.invalid";
const OTHER = "other.invalid"; // a server nobody has been told about
let peer: Server;
/** Every request that reached the fake peer, in order. A blocked server must add nothing to this. */
let received: { method: string; url: string }[];
/** What the fake peer does with federation calls: normal, or `blocksUs` (403 federation_domain_blocked). */
let peerAnswers: { blocksUs: boolean };

beforeEach(async () => {
  received = [];
  peerAnswers = { blocksUs: false };
  peer = createServer((req, res) => {
    received.push({ method: req.method ?? "", url: req.url ?? "" });
    res.setHeader("Content-Type", "application/json");
    if (peerAnswers.blocksUs && req.url?.startsWith("/federation/v1/")) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "federation_domain_blocked" }));
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

const block = (...domains: string[]) => {
  config.federationPolicy = createDomainPolicy([], domains);
};
const allowOnly = (...domains: string[]) => {
  config.federationPolicy = createDomainPolicy(domains, []);
};
const lift = () => {
  config.federationPolicy = createDomainPolicy([], []);
};
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

describe("answering other servers", () => {
  const reachesRoute = async (domain: string) => {
    const caller = await registerTestPeer(domain);
    // No such community: a request that gets as far as the route is a 404, one that is turned away first is a 403.
    return signedPost(caller, "/federation/v1/communities/none/members", { protocolId: newProtocolId(), username: "x" });
  };

  it("answers every server by default", async () => {
    await registerUser("bob");
    expect((await reachesRoute("alice.test")).status).toBe(404);
  });

  it("refuses a blocked server, and still answers the others", async () => {
    await registerUser("bob");
    block("spam.test");

    const refused = await reachesRoute("spam.test");
    const answered = await reachesRoute("alice.test");

    expect([refused.status, refused.body]).toEqual([403, { error: "federation_domain_blocked" }]);
    expect(answered.status).toBe(404);
  });

  it("with an allow list, answers the servers on it and refuses every other, the same way", async () => {
    await registerUser("bob");
    allowOnly("alice.test");

    const listed = await reachesRoute("alice.test");
    const stranger = await reachesRoute("stranger.test");

    expect(listed.status).toBe(404);
    expect([stranger.status, stranger.body]).toEqual([403, { error: "federation_domain_blocked" }]);
  });

  it("refuses every federation endpoint for a blocked server, whatever the request", async () => {
    await registerUser("bob");
    const caller = await registerTestPeer("spam.test");
    block("spam.test");

    for (const path of [
      "/federation/v1/users/bob",
      "/federation/v1/friend-requests",
      "/federation/v1/conversations",
      "/federation/v1/messages",
      "/federation/v1/presence",
      "/federation/v1/communities/x/members",
      "/federation/v1/communities/x/invites",
      "/federation/v1/communities/x/updated",
    ]) {
      const res = await signedPost(caller, path, {});
      expect([res.status, res.body], path).toEqual([403, { error: "federation_domain_blocked" }]);
    }
  });

  it("does not contact a blocked or unlisted server to find out who is asking, and caches nothing about it", async () => {
    allowOnly("alice.test");
    const peersBefore = await prisma.federationPeer.count();

    const res = await api
      .post("/federation/v1/messages")
      .set("X-Federation-Origin", PEER)
      .set("X-Federation-Timestamp", String(Date.now()))
      .set("X-Federation-Signature", "x")
      .send({});

    expect([res.status, res.body.error]).toEqual([403, "federation_domain_blocked"]);
    expect(received).toEqual([]); // it did not go and read that server's .well-known
    expect(await prisma.federationPeer.count()).toBe(peersBefore);
  });

  it("compares the claimed server without regard to case", async () => {
    block("spam.test");
    const caller = await registerTestPeer("spam.test");

    const res = await signedPost({ ...caller, domain: "SPAM.test" }, "/federation/v1/messages", {});

    expect([res.status, res.body.error]).toEqual([403, "federation_domain_blocked"]);
  });

  it("still requires a valid signature from a server that is permitted", async () => {
    allowOnly("alice.test");
    await registerTestPeer("alice.test");

    const res = await api
      .post("/federation/v1/messages")
      .set("X-Federation-Origin", "alice.test")
      .set("X-Federation-Timestamp", String(Date.now()))
      .set("X-Federation-Signature", "forged")
      .send({});

    expect(res.status).toBe(401);
  });

  it("answers the on/off switch first: a private server says it is private, not that you are blocked", async () => {
    block("spam.test");
    config.federationEnabled = false;

    const res = await api.post("/federation/v1/messages").set("X-Federation-Origin", "spam.test").send({});

    expect([res.status, res.body.error]).toEqual([403, "federation_disabled"]);
  });

  it("leaves the discovery document and the ordinary API alone", async () => {
    allowOnly("alice.test");
    const alice = await registerUser("alice");

    const doc = await api.get("/.well-known/communication-platform").set("Origin", "https://anywhere.example");
    const me = await api.get("/api/v1/users/me").set(authHeader(alice.accessToken));

    expect(doc.status).toBe(200);
    expect(doc.body.federation).toMatchObject({ enabled: true, apiBase: "/federation/v1" }); // stays public: a picker reads it
    expect(JSON.stringify(doc.body)).not.toContain("alice.test"); // and does not say who is allowed
    expect(me.status).toBe(200);
  });
});

describe("starting something with a server this one does not talk to", () => {
  it("is refused plainly when adding a friend there, with nothing contacted or stored", async () => {
    const alice = await registerUser("alice");
    block(PEER);

    const res = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: `dave:${PEER}` });

    expect([res.status, res.body.error]).toEqual([403, "federation_domain_blocked"]); // not user_not_found, which would be untrue
    expect(received).toEqual([]);
    expect(await prisma.user.count({ where: { isRemote: true } })).toBe(0);
    expect(await prisma.friendRequest.count()).toBe(0);
  });

  it("is refused when starting a direct message or group with someone there", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    block(PEER);

    const dm = await api.post("/api/v1/conversations").set(authHeader(alice.accessToken)).send({ type: "DM", memberUsernames: [`dave:${PEER}`] });
    const group = await api
      .post("/api/v1/conversations")
      .set(authHeader(alice.accessToken))
      .send({ type: "GROUP", memberUsernames: ["bob", `dave:${PEER}`], title: "Mixed" });

    expect([dm.status, dm.body.error]).toEqual([403, "federation_domain_blocked"]);
    expect([group.status, group.body.error]).toEqual([403, "federation_domain_blocked"]);
    expect(received).toEqual([]);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("is refused when joining a community there, with nothing cached", async () => {
    const alice = await registerUser("alice");
    block(PEER);

    const res = await api.post(`/api/v1/communities/${encodeURIComponent(`REMOTECOMM01:${PEER}#K7M2QXR9TB`)}/members`).set(authHeader(alice.accessToken)).send({});

    expect([res.status, res.body.error]).toEqual([403, "federation_domain_blocked"]);
    expect(received).toEqual([]);
    expect(await prisma.community.count()).toBe(0);
  });

  it("is refused for a server that is not on the allow list, and allowed for one that is", async () => {
    const alice = await registerUser("alice");
    allowOnly(OTHER);
    const refused = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: `dave:${PEER}` });

    allowOnly(PEER);
    const allowed = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: `dave:${PEER}` });

    expect([refused.status, refused.body.error]).toEqual([403, "federation_domain_blocked"]);
    expect(allowed.status).toBe(201);
  });

  it("works exactly as before when nothing is limited, and for people on this server whatever is", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    allowOnly(OTHER);

    const local = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "bob" });
    lift();
    const remote = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: `dave:${PEER}` });

    expect(local.status).toBe(201);
    expect(remote.status).toBe(201);
  });

  // A group made on another server that includes someone from a third: this server checks that person with THEIR server,
  // which it will not contact if it is not permitted.
  describe("a conversation another server describes that includes someone from a third server", () => {
    const describedBy = async (thirdDomain: string) => {
      const caller = await registerTestPeer("alice.test");
      return signedPost(caller, "/federation/v1/conversations", {
        conversationId: newProtocolId(),
        type: "GROUP",
        members: [
          { username: "bob", domain: config.domain, protocolId: newProtocolId() },
          { username: "dave", domain: thirdDomain, protocolId: "dave-protocol-id", displayName: "Dave" },
        ],
      });
    };

    it("is accepted when the third server is permitted: its person is checked with it", async () => {
      await registerUser("bob");

      const res = await describedBy(PEER);

      expect(res.status).toBe(201);
      expect(received.some((r) => r.url.startsWith("/federation/v1/users/dave"))).toBe(true);
    });

    it("is refused when the third server is not: it is not asked, and the person is not stored", async () => {
      await registerUser("bob");
      block(PEER);

      const res = await describedBy(PEER);

      expect([res.status, res.body.error]).toEqual([502, "member_verification_failed"]);
      expect(received).toEqual([]);
      expect(await prisma.conversation.count()).toBe(0);
      expect(await prisma.user.count({ where: { username: "dave" } })).toBe(0);
    });
  });
});

describe("what already exists with a server that is no longer permitted", () => {
  it("is kept, and can still be read", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    await api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken)).send({ content: "from before" });
    await waitForPendingDeliveries();
    block(PEER);
    received.length = 0;

    const messages = await api.get(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken));
    const friends = await api.get("/api/v1/friends").set(authHeader(alice.accessToken));

    expect(messages.body.messages.map((m: { content: string }) => m.content)).toContain("from before");
    expect(friends.body.friends.map((f: { identity: string }) => f.identity)).toContain(`@dave:${PEER}`);
    expect(received).toEqual([]);
  });

  it("keeps what people write toward it, undelivered and uncounted, instead of sending it", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    block(PEER);

    const sent = await api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken)).send({ content: "are you there?" });
    await waitForPendingDeliveries();

    expect(sent.status).toBe(201); // stored here
    expect(received).toEqual([]);
    expect(await outboxRows()).toMatchObject([{ domain: PEER, path: "/messages", status: "PENDING", attempts: 0 }]);
  });

  it("does not deliver it on the worker's pass or a flush, nor count either as an attempt", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    block(PEER);
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

  it("delivers everything that was held, in order, once the server is permitted again: nothing is lost", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    block(PEER);
    for (const content of ["one", "two", "three"]) {
      await api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken)).send({ content });
    }
    await waitForPendingDeliveries();
    expect(received).toEqual([]);
    expect(await outboxRows()).toHaveLength(3);

    lift();
    await processDueOutboxEvents();

    expect(received.filter((r) => r.url === "/federation/v1/messages")).toHaveLength(3);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("does not hold up the servers that are permitted: only the blocked one waits", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    // A second remote person, on a server that stays permitted, in the same sort of conversation.
    await prisma.federationOutboxEvent.createMany({
      data: [
        { domain: PEER, path: "/messages", body: { n: 1 } },
        { domain: OTHER, path: "/messages", body: { n: 2 } },
      ],
    });
    config.federationPeerOverrides[OTHER] = config.federationPeerOverrides[PEER];
    block(PEER);

    await processDueOutboxEvents();

    const left = await outboxRows();
    expect(left.map((r) => r.domain)).toEqual([PEER]); // OTHER's was delivered, PEER's waits
    expect(left[0]).toMatchObject({ status: "PENDING", attempts: 0 });
    delete config.federationPeerOverrides[OTHER];
    expect(conversationId).toBeTruthy();
  });

  it("tells a blocked server nothing about a change of status, and logs no failure for it", async () => {
    const alice = await registerUser("alice");
    await withRemoteFriend(alice);
    block(PEER);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await api.patch("/api/v1/users/me/presence").set(authHeader(alice.accessToken)).send({ status: "BUSY" });
    await waitForPendingDeliveries();

    expect(res.status).toBe(200);
    expect(received).toEqual([]);
    expect(errors.mock.calls.filter((call) => String(call[0]).includes("presence push"))).toEqual([]);
    errors.mockRestore();
  });

  it("tells it again when it is permitted", async () => {
    const alice = await registerUser("alice");
    await withRemoteFriend(alice);

    await api.patch("/api/v1/users/me/presence").set(authHeader(alice.accessToken)).send({ status: "BUSY" });

    expect(received.some((r) => r.url === "/federation/v1/presence")).toBe(true);
  });

  it("refuses what needs the other server's say-so, as 403 federation_domain_blocked, not as unreachable", async () => {
    const alice = await registerUser("alice");
    const owner = await prisma.user.create({
      data: { protocolId: newProtocolId(), username: "olga", displayName: "Olga", homeserverDomain: PEER, isRemote: true },
    });
    const community = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far Club", ownerId: owner.id, homeserverDomain: PEER, isRemote: true } });
    const aliceRow = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    await prisma.communityMember.create({ data: { communityId: community.id, userId: aliceRow.id } });
    const channel = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: community.id, name: "general", position: 0 } });
    block(PEER);

    const res = await api.post(`/api/v1/channels/${channel.protocolId}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello" });

    expect([res.status, res.body.error]).toEqual([403, "federation_domain_blocked"]);
    expect(received).toEqual([]);
  });
});

// The other side of it: this server may talk to a peer, but the peer has THIS server's domain blocked (or does not list it).
// Like a peer that has gone private, that is the other server's state, not a verdict on what was sent.
describe("a peer that has this server blocked", () => {
  it("keeps what was meant for it, to try again, rather than recording it as rejected and losing it for good", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    peerAnswers.blocksUs = true;

    await api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello?" });
    await waitForPendingDeliveries();

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PENDING", attempts: 1, lastError: "peer_federation_domain_blocked" });
    expect(rows[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("delivers it once the peer lets this server in", async () => {
    const alice = await registerUser("alice");
    const { conversationId } = await withRemoteFriend(alice);
    peerAnswers.blocksUs = true;
    await api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello?" });
    await waitForPendingDeliveries();
    peerAnswers.blocksUs = false;
    await prisma.federationOutboxEvent.updateMany({ data: { nextAttemptAt: new Date() } });
    received.length = 0;

    await processDueOutboxEvents();

    expect(received.filter((r) => r.url === "/federation/v1/messages")).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("is reported to your own people as a server that could not be reached, not as this server blocking it", async () => {
    const alice = await registerUser("alice");
    const owner = await prisma.user.create({
      data: { protocolId: newProtocolId(), username: "olga", displayName: "Olga", homeserverDomain: PEER, isRemote: true },
    });
    const community = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far Club", ownerId: owner.id, homeserverDomain: PEER, isRemote: true } });
    const aliceRow = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    await prisma.communityMember.create({ data: { communityId: community.id, userId: aliceRow.id } });
    const channel = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: community.id, name: "general", position: 0 } });
    await prisma.federationPeer.create({ data: { domain: PEER, baseUrl: config.federationPeerOverrides[PEER], publicKey: `${PEER}-key` } });
    peerAnswers.blocksUs = true;

    const res = await api.post(`/api/v1/channels/${channel.protocolId}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello" });

    expect([res.status, res.body.error]).toEqual([502, "federation_unreachable"]);
  });
});
