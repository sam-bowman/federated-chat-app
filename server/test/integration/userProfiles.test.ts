// Profiles (#150): the optional fields a person can set (pronouns, accent colour), the endpoint that shows
// someone's profile to someone else (who may see it, what it says about the relationship, and how a person
// on ANOTHER server is looked up), and the federation payload that carries the new fields.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { signRequest } from "../../src/lib/federation/signing.js";
import { ensureRemoteUser } from "../../src/modules/federation/remoteUsers.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;

const patchMe = (who: Registered, body: object) => api.patch("/api/v1/users/me").set(authHeader(who.accessToken)).send(body);
const profileOf = (viewer: Registered, id: string) =>
  api.get(`/api/v1/users/${id}/profile`).set(authHeader(viewer.accessToken));

async function befriend(a: Registered, b: Registered) {
  const sent = await api.post("/api/v1/friends/requests").set(authHeader(a.accessToken)).send({ username: b.user.username });
  await api.post(`/api/v1/friends/requests/${sent.body.request.id}/accept`).set(authHeader(b.accessToken));
}

describe("PATCH /api/v1/users/me: pronouns and accent colour", () => {
  it("sets them, trimming the pronouns and storing the colour in lower case", async () => {
    const alice = await registerUser("alice");

    const res = await patchMe(alice, { pronouns: "  she/her ", accentColor: "#AA00FF" });

    expect(res.status).toBe(200);
    expect(res.body.user.pronouns).toBe("she/her");
    expect(res.body.user.accentColor).toBe("#aa00ff");
    const stored = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    expect(stored.pronouns).toBe("she/her");
    expect(stored.accentColor).toBe("#aa00ff");
  });

  it("clears them with null, and empty pronouns mean none", async () => {
    const alice = await registerUser("alice");
    await patchMe(alice, { pronouns: "she/her", accentColor: "#aa00ff" });

    const res = await patchMe(alice, { pronouns: "", accentColor: null });

    expect(res.body.user.pronouns).toBeNull();
    expect(res.body.user.accentColor).toBeNull();
  });

  it("leaves a field alone when the request does not mention it", async () => {
    const alice = await registerUser("alice");
    await patchMe(alice, { pronouns: "she/her", accentColor: "#aa00ff" });

    const res = await patchMe(alice, { bio: "hello" });

    expect(res.body.user.pronouns).toBe("she/her");
    expect(res.body.user.accentColor).toBe("#aa00ff");
    expect(res.body.user.bio).toBe("hello");
  });

  it("refuses pronouns that are too long, or have line breaks or control characters, changing nothing", async () => {
    const alice = await registerUser("alice");
    await patchMe(alice, { pronouns: "she/her" });

    for (const bad of ["x".repeat(33), "she\nher", "she\u0000her"]) {
      const res = await patchMe(alice, { pronouns: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toBe("invalid_pronouns");
    }
    expect((await prisma.user.findFirstOrThrow({ where: { username: "alice" } })).pronouns).toBe("she/her");
  });

  it("refuses anything that is not #rrggbb as an accent colour", async () => {
    const alice = await registerUser("alice");

    for (const bad of ["red", "#fff", "rgb(1,2,3)", "url(x)", "#gggggg", ""]) {
      const res = await patchMe(alice, { accentColor: bad });
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toBe("invalid_accent_color");
    }
  });

  it("does not let a name or bio change slip a bad profile field past the check", async () => {
    const alice = await registerUser("alice");

    const res = await patchMe(alice, { displayName: "Alice 2", accentColor: "nope" });

    expect(res.status).toBe(400);
    expect((await prisma.user.findFirstOrThrow({ where: { username: "alice" } })).displayName).not.toBe("Alice 2");
  });
});

describe("GET /api/v1/users/:id/profile (a person on this server)", () => {
  it("shows your own profile, with the signal that it is yours", async () => {
    const alice = await registerUser("alice", { displayName: "Alice A" });
    await patchMe(alice, { bio: "I like maps", pronouns: "she/her", accentColor: "#112233" });

    const res = await profileOf(alice, alice.user.id);

    expect(res.status).toBe(200);
    expect(res.body.profile.user).toMatchObject({
      id: alice.user.id,
      displayName: "Alice A",
      bio: "I like maps",
      pronouns: "she/her",
      accentColor: "#112233",
    });
    expect(res.body.profile.relationship.isSelf).toBe(true);
    expect(res.body.profile.relationship.canBlock).toBe(false);
    expect(res.body.profile.homeServerReachable).toBe(true);
    expect(new Date(res.body.profile.memberSince).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("shows someone else's public profile to a stranger, with no way to see more than a friend list would", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await patchMe(bob, { bio: "Bob's bio", pronouns: "he/him" });

    const res = await profileOf(alice, bob.user.id);

    expect(res.status).toBe(200);
    expect(res.body.profile.user).toMatchObject({ id: bob.user.id, bio: "Bob's bio", pronouns: "he/him" });
    expect(res.body.profile.relationship).toEqual({
      isSelf: false,
      isFriend: false,
      blockedByMe: false,
      canBlock: true,
      pendingRequest: null,
    });
    // Nothing private about the account leaves the server.
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("passwordHash");
    expect(res.body.profile.user.totpEnabled).toBeUndefined();
    expect(Object.keys(res.body.profile.user)).not.toContain("email");
  });

  it("uses the protocol id, never the database id, and answers 404 for an id nobody has", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const bobRow = await prisma.user.findFirstOrThrow({ where: { username: "bob" } });

    expect((await profileOf(alice, bobRow.id)).status).toBe(404); // the database id means nothing to a client
    expect((await profileOf(alice, newProtocolId())).status).toBe(404);
    expect((await profileOf(alice, bob.user.id)).status).toBe(200);
  });

  it("requires you to be signed in", async () => {
    const bob = await registerUser("bob");

    expect((await api.get(`/api/v1/users/${bob.user.id}/profile`)).status).toBe(401);
  });

  it("says whether you are friends", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await befriend(alice, bob);

    expect((await profileOf(alice, bob.user.id)).body.profile.relationship.isFriend).toBe(true);
    expect((await profileOf(bob, alice.user.id)).body.profile.relationship.isFriend).toBe(true);
  });

  it("says which way a pending friend request goes", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const sent = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "bob" });

    const fromAlice = (await profileOf(alice, bob.user.id)).body.profile.relationship.pendingRequest;
    const fromBob = (await profileOf(bob, alice.user.id)).body.profile.relationship.pendingRequest;

    expect(fromAlice).toEqual({ id: sent.body.request.id, direction: "outgoing" });
    expect(fromBob).toEqual({ id: sent.body.request.id, direction: "incoming" });
  });

  // Someone who has blocked you has nothing to show you; but you can still reach the profile of someone YOU
  // blocked, because that is where Unblock is.
  it("has no profile for you if they blocked you, and still has theirs if you blocked them", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await api.post("/api/v1/friends/blocks").set(authHeader(bob.accessToken)).send({ username: "alice" });

    expect((await profileOf(alice, bob.user.id)).status).toBe(404);
    const mine = await profileOf(bob, alice.user.id);
    expect(mine.status).toBe(200);
    expect(mine.body.profile.relationship.blockedByMe).toBe(true);
  });

  it("shows INVISIBLE to others as offline, and to yourself as invisible", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await api.patch("/api/v1/users/me/presence").set(authHeader(bob.accessToken)).send({ status: "INVISIBLE" });

    expect((await profileOf(alice, bob.user.id)).body.profile.user.presence.status).toBe("OFFLINE");
    expect((await profileOf(bob, bob.user.id)).body.profile.user.presence.status).toBe("INVISIBLE");
  });
});

describe("GET /api/v1/users/:id/profile (a person on another server)", () => {
  const DOMAIN = "carol.invalid";
  let peer: Server;
  let port: number;
  let carolId: string;
  /** What carol's server answers to GET /federation/v1/users/carol; null = a server error. */
  let answer: unknown;
  let requests: string[];

  beforeEach(async () => {
    carolId = newProtocolId();
    requests = [];
    answer = { user: carolOwnProfile(), memberSince: "2025-03-04T05:06:07.000Z" };
    peer = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/.well-known/communication-platform") {
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "carol-key", apiBase: "/federation/v1" } }));
        return;
      }
      if (req.url?.split("?")[0] === "/federation/v1/users/carol") {
        if (answer === null) {
          res.statusCode = 500;
          res.end("{}");
        } else {
          res.end(JSON.stringify(answer));
        }
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    port = (peer.address() as { port: number }).port;
    config.federationPeerOverrides[DOMAIN] = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[DOMAIN];
    await new Promise<void>((resolve) => peer.close(() => resolve()));
  });

  function carolOwnProfile(overrides: Record<string, unknown> = {}) {
    return {
      id: carolId,
      username: "carol",
      displayName: "Carol Remote",
      avatarUrl: "/uploads/carol.png",
      bio: "Hello from far away",
      pronouns: "she/her",
      accentColor: "#00AAFF",
      presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
      ...overrides,
    };
  }

  /** The cached stand-in for carol, as a friend request or a message from her would have left it. */
  const stubForCarol = () =>
    ensureRemoteUser({ protocolId: carolId, username: "carol", domain: DOMAIN, displayName: "Carol (cached)", avatarUrl: null });

  it("asks the person's own server, shows what it says, and refreshes the cached copy", async () => {
    const alice = await registerUser("alice");
    await stubForCarol();

    const res = await profileOf(alice, carolId);

    expect(res.status).toBe(200);
    expect(res.body.profile.user).toMatchObject({
      id: carolId,
      identity: `@carol:${DOMAIN}`,
      displayName: "Carol Remote",
      bio: "Hello from far away",
      pronouns: "she/her",
      accentColor: "#00aaff",
    });
    expect(res.body.profile.homeServerReachable).toBe(true);
    expect(res.body.profile.memberSince).toBe("2025-03-04T05:06:07.000Z");
    const cached = await prisma.user.findFirstOrThrow({ where: { protocolId: carolId } });
    expect(cached).toMatchObject({ displayName: "Carol Remote", bio: "Hello from far away", pronouns: "she/her", accentColor: "#00aaff" });
  });

  it("makes a picture path on the other server an address on that server, not on ours", async () => {
    const alice = await registerUser("alice");
    await stubForCarol();

    const res = await profileOf(alice, carolId);

    expect(res.body.profile.user.avatarUrl).toBe(`http://127.0.0.1:${port}/uploads/carol.png`);
  });

  it("cannot offer to block someone on another server, which is only built for this server's people", async () => {
    const alice = await registerUser("alice");
    await stubForCarol();

    expect((await profileOf(alice, carolId)).body.profile.relationship.canBlock).toBe(false);
  });

  it("shows the new fields as empty for an older server that does not send them", async () => {
    answer = { user: { id: carolId, username: "carol", displayName: "Carol Remote", avatarUrl: null, bio: "Old bio" } };
    const alice = await registerUser("alice");
    await stubForCarol();

    const res = await profileOf(alice, carolId);

    expect(res.status).toBe(200);
    expect(res.body.profile.user).toMatchObject({ bio: "Old bio", pronouns: null, accentColor: null });
    expect(res.body.profile.memberSince).toBeNull();
    expect(res.body.profile.homeServerReachable).toBe(true);
  });

  it("falls back to the cached copy when the person's server is down, and says so", async () => {
    answer = null;
    const alice = await registerUser("alice");
    await stubForCarol();

    const res = await profileOf(alice, carolId);

    expect(res.status).toBe(200);
    expect(res.body.profile.user.displayName).toBe("Carol (cached)");
    expect(res.body.profile.homeServerReachable).toBe(false);
    expect(res.body.profile.memberSince).toBeNull();
  });

  it("falls back to the cached copy when the server cannot even be reached", async () => {
    const alice = await registerUser("alice");
    await stubForCarol();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    peer = createServer(); // so afterEach has something to close
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));

    const res = await profileOf(alice, carolId);

    expect(res.status).toBe(200);
    expect(res.body.profile.homeServerReachable).toBe(false);
    expect(res.body.profile.user.displayName).toBe("Carol (cached)");
  });

  // The cache-poisoning concern from CLAUDE.md, for profiles: a server may only speak for its own person.
  it("ignores an answer that is about someone else (a different protocol id)", async () => {
    answer = { user: carolOwnProfile({ id: newProtocolId(), displayName: "Not Carol", bio: "evil" }) };
    const alice = await registerUser("alice");
    await stubForCarol();

    const res = await profileOf(alice, carolId);

    expect(res.body.profile.user.displayName).toBe("Carol (cached)");
    expect(res.body.profile.user.bio).toBeNull();
    expect(res.body.profile.homeServerReachable).toBe(false);
    const cached = await prisma.user.findFirstOrThrow({ where: { protocolId: carolId } });
    expect(cached.bio).toBeNull();
  });

  it("ignores an answer for a different username", async () => {
    answer = { user: carolOwnProfile({ username: "mallory" }) };
    const alice = await registerUser("alice");
    await stubForCarol();

    expect((await profileOf(alice, carolId)).body.profile.user.displayName).toBe("Carol (cached)");
  });

  it("drops each unsafe field a server sends and keeps the rest, never failing the profile", async () => {
    answer = {
      user: carolOwnProfile({
        avatarUrl: "javascript:alert(1)",
        bio: "x".repeat(5000),
        pronouns: "p".repeat(100),
        accentColor: "url(javascript:alert(1))",
        displayName: "Carol\u0000Remote",
      }),
      memberSince: "not a date",
    };
    const alice = await registerUser("alice");
    await stubForCarol();

    const res = await profileOf(alice, carolId);

    expect(res.status).toBe(200);
    expect(res.body.profile.user).toMatchObject({ avatarUrl: null, bio: null, pronouns: null, accentColor: null });
    expect(res.body.profile.user.displayName).toBe("Carol (cached)"); // an unusable name keeps the cached one
    expect(res.body.profile.memberSince).toBeNull();
    expect(res.body.profile.homeServerReachable).toBe(true);
  });

  it("does not trust a join date in the future", async () => {
    answer = { user: carolOwnProfile(), memberSince: "2999-01-01T00:00:00.000Z" };
    const alice = await registerUser("alice");
    await stubForCarol();

    expect((await profileOf(alice, carolId)).body.profile.memberSince).toBeNull();
  });

  it("asks the other server only for this person, once per profile view", async () => {
    const alice = await registerUser("alice");
    await stubForCarol();

    await profileOf(alice, carolId);

    expect(requests.filter((u) => u.startsWith("/federation/v1/users/"))).toEqual(["/federation/v1/users/carol"]);
  });

  it("is not asked about at all for a person on this server", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");

    await profileOf(alice, bob.user.id);

    expect(requests).toEqual([]);
  });
});

describe("GET /federation/v1/users/:username (what we tell other servers)", () => {
  function signedGet(peer: { domain: string; privateKey: string }, path: string) {
    const { timestamp, signature } = signRequest(peer.privateKey, "GET", path, "");
    return api
      .get(path)
      .set("X-Federation-Origin", peer.domain)
      .set("X-Federation-Timestamp", timestamp)
      .set("X-Federation-Signature", signature);
  }

  it("includes the profile fields and when the account was created", async () => {
    const bob = await registerUser("bob");
    await patchMe(bob, { bio: "Bob's bio", pronouns: "he/him", accentColor: "#ABCDEF" });
    const peer = await registerTestPeer("alice.test");

    const res = await signedGet(peer, "/federation/v1/users/bob");

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: bob.user.id, bio: "Bob's bio", pronouns: "he/him", accentColor: "#abcdef" });
    expect(new Date(res.body.memberSince).getTime()).toBeLessThanOrEqual(Date.now());
    expect(res.body.user.totpEnabled).toBeUndefined();
  });

  it("never reveals an invisible person's true status to another server", async () => {
    const bob = await registerUser("bob");
    await api.patch("/api/v1/users/me/presence").set(authHeader(bob.accessToken)).send({ status: "INVISIBLE" });
    const peer = await registerTestPeer("alice.test");

    const res = await signedGet(peer, "/federation/v1/users/bob");

    expect(res.body.user.presence.status).toBe("OFFLINE");
  });
});
