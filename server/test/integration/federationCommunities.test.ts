// Covers federated communities: join/leave, read via cache + relay,
// structural resync (PR A), and the synchronous send/edit/delete/react
// authorize-and-persist proxy (PR B) - see protocol/federation.md's
// "Communities" section for the full design.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { signRequest } from "../../src/lib/federation/signing.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

/** signedPost (test/helpers/federation.ts) always POSTs - build the GET equivalent,
 *  signing an empty string (not "{}") the same way a real bodyless GET must. */
function signedGet(peer: { domain: string; privateKey: string }, path: string) {
  const { timestamp, signature } = signRequest(peer.privateKey, "GET", path, "");
  return api
    .get(path)
    .set("X-Federation-Origin", peer.domain)
    .set("X-Federation-Timestamp", timestamp)
    .set("X-Federation-Signature", signature);
}

const HOME_DOMAIN = "home.invalid";

beforeEach(resetDb);
afterAll(disconnectDb);

async function createLocalCommunity(ownerToken: string, name = "Test Community") {
  const res = await api.post("/api/v1/communities").set(authHeader(ownerToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community as { id: string; channels: { id: string; name: string }[] };
}

/** Seeds a remote-cached Community row directly - for tests that only need a
 *  pre-existing cache without going through the full join round trip. */
async function seedRemoteCommunityStub(domain: string) {
  const owner = await seedRemoteUser(domain, `owner-${newProtocolId().slice(0, 6).toLowerCase()}`);
  return prisma.community.create({
    data: { protocolId: newProtocolId(), name: "Remote Community", ownerId: owner.id, homeserverDomain: domain, isRemote: true },
  });
}

/** A cached remote-stub User row, for tests that need an existing remote
 *  member without going through a real join round trip. */
async function seedRemoteUser(domain: string, username: string) {
  return prisma.user.create({
    data: { protocolId: newProtocolId(), username, displayName: username, homeserverDomain: domain, isRemote: true },
  });
}

describe("POST /federation/v1/communities/:id/members (join, home-side)", () => {
  it("lets a remote peer's user join, trusting only the caller's own identity", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");

    const res = await signedPost(alice, `/federation/v1/communities/${community.id}/members`, {
      protocolId: newProtocolId(),
      username: "alice",
      displayName: "Alice",
    });

    expect(res.status).toBe(201);
    expect(res.body.community.protocolId).toBe(community.id);
    const stub = await prisma.user.findFirst({ where: { username: "alice", homeserverDomain: "alice.test" } });
    expect(stub).not.toBeNull();
    const membership = await prisma.communityMember.findFirst({ where: { user: { id: stub!.id } } });
    expect(membership).not.toBeNull();
  });

  it("rejects a banned remote user", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");
    const alicesProtocolId = newProtocolId();

    // Join once to create the stub, then ban them, then try again.
    await signedPost(alice, `/federation/v1/communities/${community.id}/members`, {
      protocolId: alicesProtocolId,
      username: "alice",
      displayName: "Alice",
    });
    const stub = await prisma.user.findFirstOrThrow({ where: { username: "alice", homeserverDomain: "alice.test" } });
    const communityRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
    await prisma.communityBan.create({ data: { communityId: communityRow.id, userId: stub.id } });

    const res = await signedPost(alice, `/federation/v1/communities/${community.id}/members`, {
      protocolId: alicesProtocolId,
      username: "alice",
      displayName: "Alice",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("banned");
  });

  it("rejects joining through a server that's only a cache of the community, not its home", async () => {
    const remoteStub = await seedRemoteCommunityStub("elsewhere.invalid");
    const alice = await registerTestPeer("alice.test");

    const res = await signedPost(alice, `/federation/v1/communities/${remoteStub.protocolId}/members`, {
      protocolId: newProtocolId(),
      username: "alice",
      displayName: "Alice",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_community_home");
  });
});

describe("POST /federation/v1/communities/:id/members/leave (home-side)", () => {
  it("removes the caller's own user, idempotently", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");
    await signedPost(alice, `/federation/v1/communities/${community.id}/members`, {
      protocolId: newProtocolId(),
      username: "alice",
      displayName: "Alice",
    });

    const first = await signedPost(alice, `/federation/v1/communities/${community.id}/members/leave`, {
      username: "alice",
    });
    expect(first.status).toBe(204);
    const stub = await prisma.user.findFirstOrThrow({ where: { username: "alice", homeserverDomain: "alice.test" } });
    const communityRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
    expect(await prisma.communityMember.findFirst({ where: { communityId: communityRow.id, userId: stub.id } })).toBeNull();

    const second = await signedPost(alice, `/federation/v1/communities/${community.id}/members/leave`, {
      username: "alice",
    });
    expect(second.status).toBe(204);
  });
});

describe("GET /federation/v1/communities/:id (snapshot, home-side)", () => {
  it("returns a snapshot once the caller's domain has a member", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");
    await signedPost(alice, `/federation/v1/communities/${community.id}/members`, {
      protocolId: newProtocolId(),
      username: "alice",
      displayName: "Alice",
    });

    const res = await signedGet(alice, `/federation/v1/communities/${community.id}`);
    expect(res.status).toBe(200);
    expect(res.body.community.protocolId).toBe(community.id);
    expect(res.body.community.channels.map((c: { name: string }) => c.name)).toEqual(["general"]);
  });

  it("rejects a domain with no member", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");

    const res = await signedGet(alice, `/federation/v1/communities/${community.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_a_member_domain");
  });

  it("rejects fetching a community through a server that's only a cache", async () => {
    const remoteStub = await seedRemoteCommunityStub("elsewhere.invalid");
    const alice = await registerTestPeer("alice.test");

    const res = await signedGet(alice, `/federation/v1/communities/${remoteStub.protocolId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_community_home");
  });
});

describe("Community message send/edit/delete/react proxy (home-side authorize-and-persist)", () => {
  async function joinAsAlice(communityId: string, alice: { domain: string; privateKey: string; publicKey: string }) {
    const res = await signedPost(alice, `/federation/v1/communities/${communityId}/members`, {
      protocolId: newProtocolId(),
      username: "alice",
      displayName: "Alice",
    });
    expect(res.status).toBe(201);
  }

  it("rejects a send-proxy attempt from someone who never actually joined", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");

    const res = await signedPost(
      alice,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages`,
      { username: "alice", content: "hi" }
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_a_member");
  });

  it("authorizes and persists a send from a real member, then relays to every remote domain INCLUDING the sender's own", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");
    await joinAsAlice(community.id, alice);
    // A second remote member on a different domain, to prove the fan-out
    // reaches every remote domain, not just the sender's.
    const carol = await seedRemoteUser("carol.invalid", "carol");
    const communityRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
    await prisma.communityMember.create({ data: { communityId: communityRow.id, userId: carol.id } });

    const res = await signedPost(
      alice,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages`,
      { username: "alice", content: "hello from alice" }
    );
    expect(res.status).toBe(201);
    expect(res.body.message.content).toBe("hello from alice");
    expect(res.body.message.sender.username).toBe("alice");

    // Regression test: relaying MUST include the sender's own domain
    // (alice.test), not just other members' - confirmed live on the real
    // two-server demo that excluding it was a real bug, not just
    // unnecessary caution. The proxy caller does no local write of its
    // own; the relay is the ONLY thing that ever persists the message
    // into the sender's own server. Without it, alice's own next page
    // load would find nothing, despite her own client showing the
    // message immediately from the direct HTTP response (in-memory React
    // state, never written to her server's database).
    const outboxRows = await prisma.federationOutboxEvent.findMany({ where: { path: { contains: "/messages" } } });
    expect(outboxRows.map((r) => r.domain).sort()).toEqual(["alice.test", "carol.invalid"]);
  });

  it("rejects a send from a member who lacks SEND_MESSAGES", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");
    await joinAsAlice(community.id, alice);

    // Strip the @everyone role's SEND_MESSAGES bit.
    const communityRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
    await prisma.role.updateMany({ where: { communityId: communityRow.id, isDefault: true }, data: { permissions: 0n } });

    const res = await signedPost(
      alice,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages`,
      { username: "alice", content: "can I still send?" }
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("lets a member edit and delete their own proxied message, sender-only", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");
    await joinAsAlice(community.id, alice);

    const sendRes = await signedPost(
      alice,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages`,
      { username: "alice", content: "original" }
    );
    const messageId = sendRes.body.message.id as string;

    const editRes = await signedPost(
      alice,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages/${messageId}/edit`,
      { username: "alice", content: "edited" }
    );
    expect(editRes.status).toBe(200);
    expect(editRes.body.message.content).toBe("edited");

    const deleteRes = await signedPost(
      alice,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages/${messageId}/delete`,
      { username: "alice" }
    );
    expect(deleteRes.status).toBe(204);
    const stored = await prisma.message.findUniqueOrThrow({ where: { protocolId: messageId } });
    expect(stored.deletedAt).not.toBeNull();
  });

  it("rejects editing someone else's proxied message", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");
    await joinAsAlice(community.id, alice);
    const sendRes = await signedPost(
      alice,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages`,
      { username: "alice", content: "alice's message" }
    );

    // A second remote member, mallory, tries to edit alice's message.
    const mallory = await registerTestPeer("mallory.test");
    const joinRes = await signedPost(mallory, `/federation/v1/communities/${community.id}/members`, {
      protocolId: newProtocolId(),
      username: "mallory",
      displayName: "Mallory",
    });
    expect(joinRes.status).toBe(201);

    const editRes = await signedPost(
      mallory,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages/${sendRes.body.message.id}/edit`,
      { username: "mallory", content: "hijacked!" }
    );
    expect(editRes.status).toBe(403);
    expect(editRes.body.error).toBe("forbidden");
  });

  it("lets a member react to a message and relays onward", async () => {
    const bob = await registerUser("bob");
    const community = await createLocalCommunity(bob.accessToken);
    const alice = await registerTestPeer("alice.test");
    await joinAsAlice(community.id, alice);
    const sendRes = await signedPost(
      alice,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages`,
      { username: "alice", content: "react to me" }
    );

    const reactRes = await signedPost(
      alice,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages/${sendRes.body.message.id}/reactions`,
      { username: "alice", emoji: "👍" }
    );
    expect(reactRes.status).toBe(200);
    expect(reactRes.body.message.reactions).toEqual([{ emoji: "👍", count: 1, users: ["alice"] }]);

    const removeRes = await signedPost(
      alice,
      `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}/messages/${sendRes.body.message.id}/reactions/remove`,
      { username: "alice", emoji: "👍" }
    );
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.message.reactions).toEqual([]);
  });

  // The core injection-prevention regression test: a peer that is NOT the
  // community's real home must never be able to write into our cache of it.
  it("rejects a message relay from a domain that isn't the community's real home", async () => {
    const remoteStub = await seedRemoteCommunityStub(HOME_DOMAIN);
    const channel = await prisma.channel.create({
      data: { protocolId: newProtocolId(), communityId: remoteStub.id, name: "general", position: 0 },
    });
    const mallory = await registerTestPeer("mallory.test");

    const res = await signedPost(mallory, `/federation/v1/communities/${remoteStub.protocolId}/channels/${channel.protocolId}/messages`, {
      messageId: newProtocolId(),
      fromProtocolId: newProtocolId(),
      fromUsername: "mallory",
      fromDomain: "mallory.test",
      content: "injected!",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_community_home");
    expect(await prisma.message.findFirst({ where: { channelId: channel.id } })).toBeNull();
  });

  it("accepts a message relay from the community's real home and caches it", async () => {
    const remoteStub = await seedRemoteCommunityStub(HOME_DOMAIN);
    const channel = await prisma.channel.create({
      data: { protocolId: newProtocolId(), communityId: remoteStub.id, name: "general", position: 0 },
    });
    const home = await registerTestPeer(HOME_DOMAIN);

    const res = await signedPost(home, `/federation/v1/communities/${remoteStub.protocolId}/channels/${channel.protocolId}/messages`, {
      messageId: newProtocolId(),
      fromProtocolId: newProtocolId(),
      fromUsername: "owner",
      fromDomain: HOME_DOMAIN,
      content: "hello from home",
    });
    expect(res.status).toBe(201);
    const cached = await prisma.message.findFirst({ where: { channelId: channel.id } });
    expect(cached).not.toBeNull();
    expect(cached!.content).toBe("hello from home");
  });
});

describe("Remote member's server proxying out (join/leave)", () => {
  let homeServer: Server;
  let homePort: number;
  let joinResponseStatus: number;
  let snapshotBody: unknown;

  beforeEach(async () => {
    joinResponseStatus = 201;
    snapshotBody = {
      community: {
        protocolId: "COMMUNITYPROTOID01",
        name: "Remote Co",
        description: null,
        iconUrl: null,
        owner: { protocolId: "OWNERPROTOID01", username: "owner", domain: HOME_DOMAIN, displayName: "Owner", avatarUrl: null },
        channels: [{ protocolId: "GENERALPROTOID01", name: "general", topic: null, position: 0, type: "TEXT" }],
      },
    };
    homeServer = createServer((req, res) => {
      if (req.url === "/.well-known/communication-platform") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "home-key", apiBase: "/federation/v1" } }));
        return;
      }
      if (req.url?.endsWith("/members") && req.method === "POST") {
        res.statusCode = joinResponseStatus;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(joinResponseStatus === 201 ? snapshotBody : { error: "banned" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => homeServer.listen(0, "127.0.0.1", resolve));
    homePort = (homeServer.address() as { port: number }).port;
    config.federationPeerOverrides[HOME_DOMAIN] = `http://127.0.0.1:${homePort}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[HOME_DOMAIN];
    await new Promise<void>((resolve) => homeServer.close(() => resolve()));
  });

  it("joining a federated reference proxies to the home server and caches the returned snapshot", async () => {
    const alice = await registerUser("alice");

    const res = await api.post(`/api/v1/communities/COMMUNITYPROTOID01:${HOME_DOMAIN}/members`).set(authHeader(alice.accessToken));

    expect(res.status).toBe(201);
    expect(res.body.community.name).toBe("Remote Co");
    expect(res.body.community.channels.map((c: { name: string }) => c.name)).toEqual(["general"]);

    const cached = await prisma.community.findUnique({ where: { protocolId: "COMMUNITYPROTOID01" } });
    expect(cached).not.toBeNull();
    expect(cached!.isRemote).toBe(true);
    expect(cached!.homeserverDomain).toBe(HOME_DOMAIN);
  });

  it("surfaces the home server's rejection (e.g. banned) as the same status/body", async () => {
    joinResponseStatus = 403;
    const alice = await registerUser("alice");

    const res = await api.post(`/api/v1/communities/COMMUNITYPROTOID01:${HOME_DOMAIN}/members`).set(authHeader(alice.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("banned");
  });

  it("surfaces federation_unreachable when the home server can't be reached at all", async () => {
    const alice = await registerUser("alice");
    delete config.federationPeerOverrides[HOME_DOMAIN]; // simulate unreachable before the call

    const res = await api.post(`/api/v1/communities/COMMUNITYPROTOID01:unreachable.invalid/members`).set(authHeader(alice.accessToken));
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("federation_unreachable");
  });
});

describe("POST /federation/v1/communities/:id/updated (resync ping, remote member's side)", () => {
  let homeServer: Server;
  let homePort: number;
  let snapshotStatus: number;
  let snapshotBody: unknown;

  beforeEach(async () => {
    snapshotStatus = 200;
    snapshotBody = {
      community: {
        protocolId: "COMMUNITYPROTOID01",
        name: "Renamed Co",
        description: null,
        iconUrl: null,
        owner: { protocolId: "OWNERPROTOID01", username: "owner", domain: HOME_DOMAIN, displayName: "Owner", avatarUrl: null },
        channels: [{ protocolId: "GENERALPROTOID01", name: "general", topic: null, position: 0, type: "TEXT" }],
      },
    };
    homeServer = createServer((req, res) => {
      if (req.url === "/.well-known/communication-platform") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "home-key", apiBase: "/federation/v1" } }));
        return;
      }
      if (req.method === "GET") {
        res.statusCode = snapshotStatus;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(snapshotStatus === 200 ? snapshotBody : { error: "not_a_member_domain" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => homeServer.listen(0, "127.0.0.1", resolve));
    homePort = (homeServer.address() as { port: number }).port;
    config.federationPeerOverrides[HOME_DOMAIN] = `http://127.0.0.1:${homePort}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[HOME_DOMAIN];
    await new Promise<void>((resolve) => homeServer.close(() => resolve()));
  });

  // registerTestPeer() pre-seeds a FederationPeer cache row with a fake,
  // unreachable baseUrl (http://<domain>) - it's designed for INBOUND
  // signature verification only (its own doc comment). These tests need
  // BOTH that (to verify the incoming "/updated" ping's own signature) AND
  // a real reachable baseUrl for the handler's own OUTBOUND snapshot
  // refetch - resolvePeer() only ever consults
  // config.federationPeerOverrides on a cache MISS, so without this fix-up
  // the pre-seeded fake baseUrl wins and the refetch fails with a generic
  // network error every time.
  async function registerHomeReachableAt(baseUrl: string) {
    const peer = await registerTestPeer(HOME_DOMAIN);
    await prisma.federationPeer.update({ where: { domain: HOME_DOMAIN }, data: { baseUrl } });
    return peer;
  }

  it("refreshes the local cache from the re-fetched snapshot", async () => {
    const remoteStub = await seedRemoteCommunityStub(HOME_DOMAIN);
    await prisma.community.update({ where: { id: remoteStub.id }, data: { protocolId: "COMMUNITYPROTOID01" } });
    const home = await registerHomeReachableAt(`http://127.0.0.1:${homePort}`);

    const res = await signedPost(home, `/federation/v1/communities/COMMUNITYPROTOID01/updated`, {});
    expect(res.status).toBe(204);

    const refreshed = await prisma.community.findUniqueOrThrow({ where: { protocolId: "COMMUNITYPROTOID01" } });
    expect(refreshed.name).toBe("Renamed Co");
  });

  it("drops the local cache when the snapshot refetch comes back 403 (no longer a member)", async () => {
    snapshotStatus = 403;
    const remoteStub = await seedRemoteCommunityStub(HOME_DOMAIN);
    await prisma.community.update({ where: { id: remoteStub.id }, data: { protocolId: "COMMUNITYPROTOID01" } });
    const home = await registerHomeReachableAt(`http://127.0.0.1:${homePort}`);

    const res = await signedPost(home, `/federation/v1/communities/COMMUNITYPROTOID01/updated`, {});
    expect(res.status).toBe(204);

    expect(await prisma.community.findUnique({ where: { protocolId: "COMMUNITYPROTOID01" } })).toBeNull();
  });

  it("rejects a ping from a domain that isn't the community's real home", async () => {
    const remoteStub = await seedRemoteCommunityStub(HOME_DOMAIN);
    await prisma.community.update({ where: { id: remoteStub.id }, data: { protocolId: "COMMUNITYPROTOID01" } });
    const mallory = await registerTestPeer("mallory.test");

    const res = await signedPost(mallory, `/federation/v1/communities/COMMUNITYPROTOID01/updated`, {});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_community_home");
  });
});

describe("Management guards on a cached remote community (local side)", () => {
  it("every management endpoint rejects with 409 instead of silently mutating the local cache", async () => {
    const remoteStub = await seedRemoteCommunityStub(HOME_DOMAIN);
    const alice = await registerUser("alice");
    // registerUser() returns a serialized PublicUser - .id there is the
    // protocolId, not the local db id a Prisma relation actually needs.
    const aliceLocal = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    await prisma.communityMember.create({ data: { communityId: remoteStub.id, userId: aliceLocal.id } });

    const patch = await api.patch(`/api/v1/communities/${remoteStub.protocolId}`).set(authHeader(alice.accessToken)).send({ name: "Hijacked" });
    expect(patch.status).toBe(409);

    const channel = await api.post(`/api/v1/communities/${remoteStub.protocolId}/channels`).set(authHeader(alice.accessToken)).send({ name: "new-channel" });
    expect(channel.status).toBe(409);

    const ban = await api.post(`/api/v1/communities/${remoteStub.protocolId}/bans`).set(authHeader(alice.accessToken)).send({ username: "someone" });
    expect(ban.status).toBe(409);

    const stillLocal = await prisma.community.findUniqueOrThrow({ where: { id: remoteStub.id } });
    expect(stillLocal.name).toBe("Remote Community"); // unchanged by the PATCH attempt above
  });
});
