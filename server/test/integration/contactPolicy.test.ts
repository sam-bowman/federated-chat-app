// Who may start something with a person (#109, phase 3b): send them a friend request or put them in a conversation. Each person
// chooses ANYONE (the default), SHARED_COMMUNITY (people who share a community with them) or LOCAL_ONLY (people on this server);
// a friend is always allowed; nothing that already exists is touched. The person's own server decides, and tells the asking
// server early (a `contact` verdict on the lookup) so it can refuse plainly - and decides again when it is actually sent.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import type { ContactPolicy } from "../../src/lib/contactPolicy.js";
import { createDomainPolicy } from "../../src/lib/federationPolicy.js";
import { waitForPendingDeliveries } from "../../src/lib/federation/outbox.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedGet, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
const FAR = "far.test";
const PEER = "peer.invalid"; // a fake server we send to

const choose = async (who: Registered, policy: ContactPolicy) => {
  const res = await api.patch("/api/v1/users/me").set(authHeader(who.accessToken)).send({ contactPolicy: policy });
  expect(res.status).toBe(200);
};
const row = (username: string) => prisma.user.findFirstOrThrow({ where: { username, isRemote: false } });
const befriend = async (a: string, b: string) => {
  const [x, y] = [(await row(a)).id, (await row(b)).id];
  await prisma.friendship.createMany({ data: [{ userId: x, friendId: y }, { userId: y, friendId: x }] });
};
const shareCommunity = async (...usernames: string[]) => {
  const ids = await Promise.all(usernames.map(async (u) => (await row(u)).id));
  await prisma.community.create({
    data: { protocolId: newProtocolId(), name: "Club", ownerId: ids[0], homeserverDomain: config.domain, members: { create: ids.map((userId) => ({ userId })) } },
  });
};
const stub = (domain: string, username = "stranger", protocolId = newProtocolId()) =>
  prisma.user.create({ data: { protocolId, username, displayName: username, homeserverDomain: domain, isRemote: true } });

const requestFriend = (from: Registered, to: string) => api.post("/api/v1/friends/requests").set(authHeader(from.accessToken)).send({ username: to });
const startDm = (from: Registered, to: string) =>
  api.post("/api/v1/conversations").set(authHeader(from.accessToken)).send({ type: "DM", memberUsernames: [to] });

describe("the setting", () => {
  it("starts as ANYONE, and is saved, shown to its owner only", async () => {
    const hidy = await registerUser("hidy");
    const other = await registerUser("other");

    expect((await row("hidy")).contactPolicy).toBe("ANYONE");
    expect(hidy.user).toMatchObject({ contactPolicy: "ANYONE" });
    const patched = await api.patch("/api/v1/users/me").set(authHeader(hidy.accessToken)).send({ contactPolicy: "SHARED_COMMUNITY" });
    expect(patched.body.user.contactPolicy).toBe("SHARED_COMMUNITY");
    expect((await row("hidy")).contactPolicy).toBe("SHARED_COMMUNITY");
    const view = await api.get(`/api/v1/users/${hidy.user.id}/profile`).set(authHeader(other.accessToken));
    expect(JSON.stringify(view.body)).not.toContain("contactPolicy");
  });

  it("accepts only the three names", async () => {
    const hidy = await registerUser("hidy");

    for (const value of ["anyone", "NOBODY", "", null, 1, true]) {
      const res = await api.patch("/api/v1/users/me").set(authHeader(hidy.accessToken)).send({ contactPolicy: value });
      expect([res.status, value]).toEqual([400, value]);
    }
    expect((await row("hidy")).contactPolicy).toBe("ANYONE");
  });
});

describe("on this server", () => {
  it("lets anyone start something under ANYONE", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");

    expect((await requestFriend(alice, "bob")).status).toBe(201);
  });

  it("lets people on this server in under LOCAL_ONLY, as this server is what it allows", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await choose(bob, "LOCAL_ONLY");

    expect((await requestFriend(alice, "bob")).status).toBe(201);
    expect((await startDm(alice, "bob")).status).toBe(201);
  });

  it("under SHARED_COMMUNITY, refuses someone with no community in common, for a request, a direct message and a group", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await registerUser("carol");
    await choose(bob, "SHARED_COMMUNITY");

    const request = await requestFriend(alice, "bob");
    const dm = await startDm(alice, "bob");
    const group = await api.post("/api/v1/conversations").set(authHeader(alice.accessToken)).send({ type: "GROUP", memberUsernames: ["bob", "carol"] });

    for (const res of [request, dm, group]) expect([res.status, res.body.error]).toEqual([403, "contact_not_allowed"]);
    expect(await prisma.friendRequest.count()).toBe(0);
    expect(await prisma.conversation.count()).toBe(0); // not even the part that did not involve bob
  });

  it("lets them in once they share a community", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await choose(bob, "SHARED_COMMUNITY");
    expect((await requestFriend(alice, "bob")).status).toBe(403);

    await shareCommunity("alice", "bob");

    expect((await requestFriend(alice, "bob")).status).toBe(201);
  });

  it("always lets a friend in, whatever was chosen", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await befriend("alice", "bob");
    await choose(bob, "SHARED_COMMUNITY");

    expect((await startDm(alice, "bob")).status).toBe(201);
  });

  it("leaves a conversation that already exists open, however it is chosen later: it is not being started", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const first = await startDm(alice, "bob");
    expect(first.status).toBe(201);
    await choose(bob, "SHARED_COMMUNITY");

    const again = await startDm(alice, "bob");
    const message = await api
      .post(`/api/v1/conversations/${first.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "still here" });

    expect(again.status).toBe(200);
    expect(again.body.conversation.id).toBe(first.body.conversation.id);
    expect(message.status).toBe(201);
  });

  it("does not let it hide the more useful answers: already friends, already pending", async () => {
    const alice = await registerUser("alice");
    const dana = await registerUser("dana");
    const bob = await registerUser("bob");
    await choose(bob, "SHARED_COMMUNITY");
    await befriend("alice", "bob");
    expect((await requestFriend(alice, "bob")).body.error).toBe("already_friends");

    expect((await requestFriend(dana, "bob")).body.error).toBe("contact_not_allowed"); // nothing between them: the setting speaks
    await prisma.friendRequest.create({ data: { protocolId: newProtocolId(), fromUserId: (await row("bob")).id, toUserId: (await row("dana")).id } });
    expect((await requestFriend(dana, "bob")).body.error).toBe("request_already_pending");
  });

  it("refuses a group when any one person added does not accept it, and says so for the whole", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const carol = await registerUser("carol");
    await choose(carol, "SHARED_COMMUNITY");
    await shareCommunity("alice", "bob");

    const res = await api.post("/api/v1/conversations").set(authHeader(alice.accessToken)).send({ type: "GROUP", memberUsernames: ["bob", "carol"] });

    expect([res.status, res.body.error]).toEqual([403, "contact_not_allowed"]);
    expect(await prisma.conversation.count()).toBe(0);
  });
});

describe("another server asking about someone", () => {
  it("says whether this person's setting lets the person it is asking for, when it names them", async () => {
    const bob = await registerUser("bob");
    const far = await registerTestPeer(FAR);
    await stub(FAR, "stranger");
    const ask = async () => (await signedGet(far, "/federation/v1/users/bob?from=stranger")).body.contact;

    expect(await ask()).toEqual({ allowed: true });
    await choose(bob, "LOCAL_ONLY");
    expect(await ask()).toEqual({ allowed: false });
    await choose(bob, "SHARED_COMMUNITY");
    expect(await ask()).toEqual({ allowed: false });
  });

  it("counts a community they share, and a friendship, for the person it names", async () => {
    const bob = await registerUser("bob");
    const far = await registerTestPeer(FAR);
    const stranger = await stub(FAR, "stranger");
    await choose(bob, "SHARED_COMMUNITY");
    const ask = async () => (await signedGet(far, "/federation/v1/users/bob?from=stranger")).body.contact.allowed;
    expect(await ask()).toBe(false);

    await prisma.community.create({
      data: { protocolId: newProtocolId(), name: "Club", ownerId: (await row("bob")).id, homeserverDomain: config.domain, members: { create: [{ userId: (await row("bob")).id }, { userId: stranger.id }] } },
    });
    expect(await ask()).toBe(true);
    await prisma.communityMember.deleteMany({});
    expect(await ask()).toBe(false);
    await choose(bob, "LOCAL_ONLY");
    await prisma.friendship.createMany({ data: [{ userId: (await row("bob")).id, friendId: stranger.id }, { userId: stranger.id, friendId: (await row("bob")).id }] });
    expect(await ask()).toBe(true); // a friend is always let in
  });

  it("says nothing about it when not asked on behalf of anyone, as every server before it did not", async () => {
    await registerUser("bob");
    const far = await registerTestPeer(FAR);

    const res = await signedGet(far, "/federation/v1/users/bob");

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("contact");
  });

  it("takes the person named to be on the asking server, whatever it claims", async () => {
    const bob = await registerUser("bob");
    await choose(bob, "LOCAL_ONLY");
    const far = await registerTestPeer(FAR);
    await registerUser("alice"); // a person on THIS server called alice: the asker cannot borrow them

    const res = await signedGet(far, "/federation/v1/users/bob?from=alice");

    expect(res.body.contact).toEqual({ allowed: false });
  });
});

describe("a friend request from another server", () => {
  const send = (far: Awaited<ReturnType<typeof registerTestPeer>>, toUsername: string, over: { requestId?: string; fromProtocolId?: string } = {}) =>
    signedPost(far, "/federation/v1/friend-requests", {
      requestId: over.requestId ?? newProtocolId(),
      fromProtocolId: over.fromProtocolId ?? newProtocolId(),
      fromUsername: "stranger",
      fromDisplayName: "Stranger",
      toUsername,
    });

  it("is delivered as ever under ANYONE", async () => {
    await registerUser("bob");
    const far = await registerTestPeer(FAR);

    expect((await send(far, "bob")).status).toBe(201);
    expect(await prisma.friendRequest.count()).toBe(1);
  });

  it("is not shown to someone who does not accept it, and the sender is told it was declined", async () => {
    const bob = await registerUser("bob");
    await choose(bob, "LOCAL_ONLY");
    const far = await registerTestPeer(FAR);
    const requestId = newProtocolId();

    const res = await send(far, "bob", { requestId });

    expect([res.status, res.body]).toEqual([201, { ok: true }]); // nothing to tell it apart from a delivered one
    expect(await prisma.friendRequest.count()).toBe(0);
    const queued = await prisma.federationOutboxEvent.findMany({ where: { path: `/friend-requests/${requestId}/decline` } });
    expect(queued.map((e) => e.domain)).toEqual([FAR]);
  });

  it("under SHARED_COMMUNITY, is delivered when a community is shared and declined when not", async () => {
    const bob = await registerUser("bob");
    await choose(bob, "SHARED_COMMUNITY");
    const far = await registerTestPeer(FAR);
    const sharer = await stub(FAR, "stranger", "stranger-protocol-id");

    const before = await send(far, "bob", { fromProtocolId: sharer.protocolId });
    expect(before.status).toBe(201);
    expect(await prisma.friendRequest.count()).toBe(0);

    await prisma.community.create({
      data: { protocolId: newProtocolId(), name: "Club", ownerId: (await row("bob")).id, homeserverDomain: config.domain, members: { create: [{ userId: (await row("bob")).id }, { userId: sharer.id }] } },
    });
    await send(far, "bob", { fromProtocolId: sharer.protocolId });

    expect(await prisma.friendRequest.count()).toBe(1);
  });

  it("is let in from a friend whatever was chosen", async () => {
    const bob = await registerUser("bob");
    await choose(bob, "LOCAL_ONLY");
    const far = await registerTestPeer(FAR);
    const friend = await stub(FAR, "stranger", "stranger-protocol-id");
    await prisma.friendship.createMany({ data: [{ userId: (await row("bob")).id, friendId: friend.id }, { userId: friend.id, friendId: (await row("bob")).id }] });

    await send(far, "bob", { fromProtocolId: friend.protocolId });

    expect(await prisma.friendRequest.count()).toBe(1);
  });

  it("leaves a request that was already delivered alone when it is sent again", async () => {
    const bob = await registerUser("bob");
    const far = await registerTestPeer(FAR);
    const requestId = newProtocolId();
    await send(far, "bob", { requestId, fromProtocolId: "stranger-protocol-id" });
    await choose(bob, "LOCAL_ONLY"); // chosen after it arrived

    const again = await send(far, "bob", { requestId, fromProtocolId: "stranger-protocol-id" });

    expect(again.status).toBe(201);
    expect(await prisma.friendRequest.count()).toBe(1);
    expect(await prisma.federationOutboxEvent.count({ where: { path: { contains: "/decline" } } })).toBe(0);
  });
});

describe("a conversation from another server", () => {
  const describe_ = (far: Awaited<ReturnType<typeof registerTestPeer>>, localUsernames: string[], extra: { createdBy?: string; others?: string[] } = {}) => {
    const members = [
      ...localUsernames.map((username) => ({ username, domain: config.domain, protocolId: newProtocolId() })),
      { username: "stranger", domain: FAR, protocolId: "stranger-protocol-id", displayName: "Stranger" },
      ...(extra.others ?? []).map((username) => ({ username, domain: FAR, protocolId: `${username}-protocol-id`, displayName: username })),
    ];
    return signedPost(far, "/federation/v1/conversations", {
      conversationId: newProtocolId(),
      type: members.length === 2 ? "DM" : "GROUP",
      members,
      createdBy: extra.createdBy,
    });
  };

  it("is made as ever under ANYONE", async () => {
    await registerUser("bob");
    const far = await registerTestPeer(FAR);

    expect((await describe_(far, ["bob"])).status).toBe(201);
    expect(await prisma.conversation.count()).toBe(1);
  });

  it("is refused for someone who does not accept it, and nothing is stored", async () => {
    const bob = await registerUser("bob");
    await choose(bob, "LOCAL_ONLY");
    const far = await registerTestPeer(FAR);

    const res = await describe_(far, ["bob"], { createdBy: "stranger" });

    expect([res.status, res.body.error]).toEqual([403, "contact_not_allowed"]);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("is not made at all when one of several people added does not accept it", async () => {
    await registerUser("bob");
    const carol = await registerUser("carol");
    await choose(carol, "LOCAL_ONLY");
    const far = await registerTestPeer(FAR);

    const res = await describe_(far, ["bob", "carol"], { createdBy: "stranger" });

    expect([res.status, res.body.error]).toEqual([403, "contact_not_allowed"]);
    expect(await prisma.conversation.count()).toBe(0);
  });

  // Which of the two comes first in the database must not matter: the one who is not let in is the one that counts.
  it.each([["before"], ["after"]])("judges the creator when the sender says who it is, and every other member when it does not (outsider added %s)", async (order) => {
    const bob = await registerUser("bob");
    await choose(bob, "SHARED_COMMUNITY");
    const far = await registerTestPeer(FAR);
    if (order === "before") await stub(FAR, "outsider", "outsider-protocol-id");
    const creator = await stub(FAR, "stranger", "stranger-protocol-id");
    if (order === "after") await stub(FAR, "outsider", "outsider-protocol-id");
    await prisma.community.create({
      data: { protocolId: newProtocolId(), name: "Club", ownerId: (await row("bob")).id, homeserverDomain: config.domain, members: { create: [{ userId: (await row("bob")).id }, { userId: creator.id }] } },
    });

    // The creator shares a community with bob; the other person added does not.
    const named = await describe_(far, ["bob"], { createdBy: "stranger", others: ["outsider"] });
    const unnamed = await describe_(far, ["bob"], { others: ["outsider"] });

    expect(named.status).toBe(201);
    expect([unnamed.status, unnamed.body.error]).toEqual([403, "contact_not_allowed"]);
  });

  it("is let in from a friend, and leaves a conversation that already exists alone", async () => {
    const bob = await registerUser("bob");
    const far = await registerTestPeer(FAR);
    const friend = await stub(FAR, "stranger", "stranger-protocol-id");
    const body = {
      conversationId: newProtocolId(),
      type: "DM",
      members: [
        { username: "bob", domain: config.domain, protocolId: newProtocolId() },
        { username: "stranger", domain: FAR, protocolId: friend.protocolId, displayName: "Stranger" },
      ],
      createdBy: "stranger",
    };
    expect((await signedPost(far, "/federation/v1/conversations", body)).status).toBe(201);
    await choose(bob, "LOCAL_ONLY"); // chosen after it exists

    const again = await signedPost(far, "/federation/v1/conversations", body);

    expect(again.status).toBe(201);
    expect(await prisma.conversation.count()).toBe(1);
  });
});

// The other direction: someone here wants to start something with a person on another server.
describe("starting something with someone on another server", () => {
  let peer: Server;
  let received: { method: string; url: string; body: string }[];
  /** What the fake server says about whether its person accepts: true, false, or nothing at all (a server that predates it). */
  let verdict: boolean | undefined;

  beforeEach(async () => {
    received = [];
    verdict = undefined;
    peer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/.well-known/communication-platform") {
          res.end(JSON.stringify({ federation: { enabled: true, publicKey: `${PEER}-key`, apiBase: "/federation/v1" } }));
          return;
        }
        if (req.url?.split("?")[0] === "/federation/v1/users/dave") {
          res.end(
            JSON.stringify({
              user: { id: "dave-protocol-id", username: "dave", displayName: "Dave", avatarUrl: null },
              contact: verdict === undefined ? undefined : { allowed: verdict },
            })
          );
          return;
        }
        res.statusCode = 201;
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    config.federationPeerOverrides[PEER] = `http://127.0.0.1:${(peer.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[PEER];
    await new Promise<void>((resolve) => peer.close(() => resolve()));
  });

  it("asks on behalf of the person who wants to, so the other server can judge them", async () => {
    const alice = await registerUser("alice");

    await requestFriend(alice, `dave:${PEER}`);

    expect(received.some((r) => r.url === "/federation/v1/users/dave?from=alice")).toBe(true);
  });

  it("is refused plainly, before anything is sent, when the other person's setting says no", async () => {
    const alice = await registerUser("alice");
    verdict = false;

    const request = await requestFriend(alice, `dave:${PEER}`);
    const dm = await startDm(alice, `dave:${PEER}`);
    await waitForPendingDeliveries();

    expect([request.status, request.body.error]).toEqual([403, "contact_not_allowed"]);
    expect([dm.status, dm.body.error]).toEqual([403, "contact_not_allowed"]);
    expect(received.filter((r) => r.method === "POST")).toEqual([]);
    expect(await prisma.friendRequest.count()).toBe(0);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("goes ahead when the other person's setting says yes", async () => {
    const alice = await registerUser("alice");
    verdict = true;

    expect((await requestFriend(alice, `dave:${PEER}`)).status).toBe(201);
  });

  it("goes ahead when the other server says nothing, as one that predates the setting does: it decides when it is sent", async () => {
    const alice = await registerUser("alice");
    verdict = undefined;

    expect((await requestFriend(alice, `dave:${PEER}`)).status).toBe(201);
    expect((await startDm(alice, `dave:${PEER}`)).status).toBe(201);
  });

  it("refuses a group when any one remote person does not accept it", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    verdict = false;

    const res = await api
      .post("/api/v1/conversations")
      .set(authHeader(alice.accessToken))
      .send({ type: "GROUP", memberUsernames: ["bob", `dave:${PEER}`] });

    expect([res.status, res.body.error]).toEqual([403, "contact_not_allowed"]);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("tells the other server who is creating a conversation, so each person added can judge them", async () => {
    const alice = await registerUser("alice");
    verdict = true;

    await startDm(alice, `dave:${PEER}`);
    await waitForPendingDeliveries();

    const sent = received.find((r) => r.method === "POST" && r.url === "/federation/v1/conversations");
    expect(sent).toBeDefined();
    expect(JSON.parse(sent!.body)).toMatchObject({ type: "DM", createdBy: "alice" });
  });
});

// The member list of a community hosted on ANOTHER server is not held here (only this server's own members and the owner are), so
// "do we share a community?" is answered by asking that community's home server, which knows. Only when the person chose it.
describe("a community hosted on another server", () => {
  let host: Server;
  let asked: { url: string }[];
  /** What the fake home server says: yes, no, an error, or (when null) nothing at all because it is down. */
  let answer: { member: boolean } | "error" | null;

  beforeEach(async () => {
    asked = [];
    answer = { member: false };
    host = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/.well-known/communication-platform") {
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: `${PEER}-key`, apiBase: "/federation/v1" } }));
        return;
      }
      asked.push({ url: req.url ?? "" });
      if (answer === null) return void req.socket.destroy();
      if (answer === "error") {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "not_a_member_domain" }));
        return;
      }
      res.end(JSON.stringify(answer));
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    config.federationPeerOverrides[PEER] = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[PEER];
    config.federationPolicy = createDomainPolicy([], []);
    await new Promise<void>((resolve) => host.close(() => resolve()));
  });

  /** bob belongs to a community hosted at PEER, whose owner is someone there. */
  async function bobInRemoteCommunity(policy: ContactPolicy = "SHARED_COMMUNITY") {
    const bob = await registerUser("bob");
    await choose(bob, policy);
    const owner = await stub(PEER, "olga");
    const community = await prisma.community.create({
      data: { protocolId: newProtocolId(), name: "Far Club", ownerId: owner.id, homeserverDomain: PEER, isRemote: true, members: { create: [{ userId: (await row("bob")).id }] } },
    });
    return { bob, community };
  }
  const ask = async (far: Awaited<ReturnType<typeof registerTestPeer>>) =>
    (await signedGet(far, "/federation/v1/users/bob?from=stranger")).body.contact.allowed as boolean;

  it("is asked about the person, naming them and where they are, and a yes means a community is shared", async () => {
    const { community } = await bobInRemoteCommunity();
    const far = await registerTestPeer(FAR);
    answer = { member: true };

    expect(await ask(far)).toBe(true);
    expect(asked).toEqual([{ url: `/federation/v1/communities/${community.protocolId}/membership?username=stranger&domain=${FAR}` }]);
  });

  it("counts a no, and any answer that is not a clear yes, as nothing shared", async () => {
    await bobInRemoteCommunity();
    const far = await registerTestPeer(FAR);

    answer = { member: false };
    expect(await ask(far)).toBe(false);
    answer = "error";
    expect(await ask(far)).toBe(false);
    answer = null; // the server hangs up
    expect(await ask(far)).toBe(false);
  });

  it("is not asked at all when the person did not choose it: it costs a question to another server", async () => {
    const { bob } = await bobInRemoteCommunity("ANYONE");
    const far = await registerTestPeer(FAR);
    answer = { member: true };

    expect(await ask(far)).toBe(true); // anyone is let in, and nothing was asked to find out
    await choose(bob, "LOCAL_ONLY");
    expect(await ask(far)).toBe(false); // a community elsewhere does not make someone local, and again nothing was asked
    expect(asked).toEqual([]);
  });

  it("is not asked about a friend, who is let in anyway", async () => {
    await bobInRemoteCommunity();
    const far = await registerTestPeer(FAR);
    const friend = await stub(FAR, "stranger");
    await prisma.friendship.createMany({ data: [{ userId: (await row("bob")).id, friendId: friend.id }, { userId: friend.id, friendId: (await row("bob")).id }] });

    expect(await ask(far)).toBe(true);
    expect(asked).toEqual([]);
  });

  it("is not asked when this server does not talk to the community's home server", async () => {
    await bobInRemoteCommunity();
    const far = await registerTestPeer(FAR);
    answer = { member: true };
    config.federationPolicy = createDomainPolicy([], [PEER]);

    expect(await ask(far)).toBe(false);
    expect(asked).toEqual([]);
  });

  it("asks at most ten community home servers, so a person in many cannot make one request slow", async () => {
    const { bob } = await bobInRemoteCommunity();
    const owner = await prisma.user.findFirstOrThrow({ where: { username: "olga", isRemote: true } });
    for (let n = 0; n < 12; n++) {
      await prisma.community.create({
        data: { protocolId: newProtocolId(), name: `Club ${n}`, ownerId: owner.id, homeserverDomain: PEER, isRemote: true, members: { create: [{ userId: (await row("bob")).id }] } },
      });
    }
    const far = await registerTestPeer(FAR);
    answer = { member: false };

    expect(await ask(far)).toBe(false);
    expect(asked.length).toBeLessThanOrEqual(10);
    expect(asked.length).toBeGreaterThan(1);
    expect(bob).toBeTruthy();
  });

  it("lets the same sender in for the same reason when they actually send a friend request", async () => {
    await bobInRemoteCommunity();
    const far = await registerTestPeer(FAR);
    answer = { member: true };

    const res = await signedPost(far, "/federation/v1/friend-requests", {
      requestId: newProtocolId(),
      fromProtocolId: newProtocolId(),
      fromUsername: "stranger",
      fromDisplayName: "Stranger",
      toUsername: "bob",
    });

    expect(res.status).toBe(201);
    expect(await prisma.friendRequest.count()).toBe(1);
  });

  it("refuses the same sender when the home server says they are not in it", async () => {
    await bobInRemoteCommunity();
    const far = await registerTestPeer(FAR);
    answer = { member: false };

    await signedPost(far, "/federation/v1/friend-requests", {
      requestId: newProtocolId(),
      fromProtocolId: newProtocolId(),
      fromUsername: "stranger",
      fromDisplayName: "Stranger",
      toUsername: "bob",
    });

    expect(await prisma.friendRequest.count()).toBe(0);
  });
});

// The home server's side of that question.
describe("answering whether someone is in a community hosted here", () => {
  const membership = (far: Awaited<ReturnType<typeof registerTestPeer>>, communityId: string, query: string) =>
    signedGet(far, `/federation/v1/communities/${communityId}/membership?${query}`);

  async function hostedCommunityWithRemoteMember() {
    const owner = await registerUser("olga");
    const member = await stub(FAR, "stranger");
    const community = await prisma.community.create({
      data: {
        protocolId: newProtocolId(),
        name: "Club",
        ownerId: (await row("olga")).id,
        homeserverDomain: config.domain,
        members: { create: [{ userId: (await row("olga")).id }, { userId: member.id }] },
      },
    });
    return { owner, community };
  }

  it("says yes for a member from any server, and for one on this server", async () => {
    const { community } = await hostedCommunityWithRemoteMember();
    const far = await registerTestPeer(FAR);

    expect((await membership(far, community.protocolId, `username=stranger&domain=${FAR}`)).body).toEqual({ member: true });
    expect((await membership(far, community.protocolId, `username=olga&domain=${config.domain}`)).body).toEqual({ member: true });
  });

  it("says no for someone who is not in it, or is on another server than the one named, and ignores the case of a domain", async () => {
    const { community } = await hostedCommunityWithRemoteMember();
    const far = await registerTestPeer(FAR);

    expect((await membership(far, community.protocolId, `username=nobody&domain=${FAR}`)).body).toEqual({ member: false });
    expect((await membership(far, community.protocolId, "username=stranger&domain=elsewhere.test")).body).toEqual({ member: false });
    expect((await membership(far, community.protocolId, `username=stranger&domain=${FAR.toUpperCase()}`)).body).toEqual({ member: true });
  });

  it("answers only a server that already has a member in it, like the snapshot", async () => {
    const { community } = await hostedCommunityWithRemoteMember();
    const outsider = await registerTestPeer("outsider.test");

    const res = await membership(outsider, community.protocolId, `username=stranger&domain=${FAR}`);

    expect([res.status, res.body.error]).toEqual([403, "not_a_member_domain"]);
  });

  it("is a 404 for a community it does not have, a 409 for one hosted elsewhere, and a 400 without who", async () => {
    const { community } = await hostedCommunityWithRemoteMember();
    const far = await registerTestPeer(FAR);
    const owner = await stub(FAR, "olga2");
    const cached = await prisma.community.create({
      data: { protocolId: newProtocolId(), name: "Elsewhere", ownerId: owner.id, homeserverDomain: FAR, isRemote: true },
    });

    expect((await membership(far, "NOSUCHCOMMUNITY", `username=stranger&domain=${FAR}`)).status).toBe(404);
    expect((await membership(far, cached.protocolId, `username=stranger&domain=${FAR}`)).status).toBe(409);
    expect((await membership(far, community.protocolId, "username=stranger")).status).toBe(400);
  });
});
