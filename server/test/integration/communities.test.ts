// Baseline local (non-federated) community/channel coverage - there was
// none before this feature touched nearly every handler in
// communities/routes.ts and channels/routes.ts, so this exists primarily
// as a regression guard that the federation-awareness added alongside it
// didn't change local-only behavior. The authorize-and-persist logic for
// a proxied send/edit/delete/react is covered by federationCommunities.test.ts
// (home-side); this file's own federated tests only exercise the PROXY
// CALLER plumbing (channels/routes.ts, messages/routes.ts) - does it build
// the right signed request and pass the response straight through.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("local community lifecycle", () => {
  it("creates a community owned by this server, with a default channel and role", async () => {
    const alice = await registerUser("alice");
    const res = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Alice's Place" });

    expect(res.status).toBe(201);
    expect(res.body.community.channels.map((c: { name: string }) => c.name)).toEqual(["general"]);

    const stored = await prisma.community.findUniqueOrThrow({ where: { protocolId: res.body.community.id } });
    expect(stored.isRemote).toBe(false);
    expect(stored.homeserverDomain).toBe("test.local");
  });

  it("lets a second local user join by bare protocolId and send a message", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const create = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Open Community" });
    const communityId = create.body.community.id;
    const channelId = create.body.community.channels[0].id;

    const join = await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(bob.accessToken));
    expect(join.status).toBe(201);

    const send = await api
      .post(`/api/v1/channels/${channelId}/messages`)
      .set(authHeader(bob.accessToken))
      .send({ content: "hello everyone" });
    expect(send.status).toBe(201);
    expect(send.body.message.content).toBe("hello everyone");
  });

  it("leaving and rejoining works", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const create = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "C" });
    const communityId = create.body.community.id;

    await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(bob.accessToken));
    const leave = await api.delete(`/api/v1/communities/${communityId}/members/me`).set(authHeader(bob.accessToken));
    expect(leave.status).toBe(204);

    const rejoin = await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(bob.accessToken));
    expect(rejoin.status).toBe(201);
  });
});

describe("community moderation (kick, ban, unban)", () => {
  it("lets the owner kick a member, who can rejoin afterward", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const create = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Mod Test" });
    const communityId = create.body.community.id;
    await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(bob.accessToken));

    const kick = await api
      .delete(`/api/v1/communities/${communityId}/members/${bob.user.id}`)
      .set(authHeader(alice.accessToken));
    expect(kick.status).toBe(204);

    const rejoin = await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(bob.accessToken));
    expect(rejoin.status).toBe(201);
  });

  it("rejects a kick from a member without KICK_MEMBERS", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const create = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Mod Test" });
    const communityId = create.body.community.id;
    await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(bob.accessToken));
    await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(carol.accessToken));

    const kick = await api
      .delete(`/api/v1/communities/${communityId}/members/${carol.user.id}`)
      .set(authHeader(bob.accessToken));
    expect(kick.status).toBe(403);
  });

  it("refuses to kick the owner", async () => {
    const alice = await registerUser("alice");
    const create = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Mod Test" });
    const communityId = create.body.community.id;

    const kick = await api
      .delete(`/api/v1/communities/${communityId}/members/${alice.user.id}`)
      .set(authHeader(alice.accessToken));
    expect(kick.status).toBe(400);
    expect(kick.body.error).toBe("cannot_kick_owner");
  });

  it("lets the owner ban a member by protocolId, blocking rejoin, lists the ban, then unbans them", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const create = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Mod Test" });
    const communityId = create.body.community.id;
    await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(bob.accessToken));

    const ban = await api
      .post(`/api/v1/communities/${communityId}/bans`)
      .set(authHeader(alice.accessToken))
      .send({ protocolId: bob.user.id, reason: "testing" });
    expect(ban.status).toBe(204);

    const rejoinAttempt = await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(bob.accessToken));
    expect(rejoinAttempt.status).toBe(403);
    expect(rejoinAttempt.body.error).toBe("banned");

    const list = await api.get(`/api/v1/communities/${communityId}/bans`).set(authHeader(alice.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.bans).toHaveLength(1);
    expect(list.body.bans[0].user.id).toBe(bob.user.id);
    expect(list.body.bans[0].reason).toBe("testing");

    const unban = await api
      .delete(`/api/v1/communities/${communityId}/bans/${bob.user.id}`)
      .set(authHeader(alice.accessToken));
    expect(unban.status).toBe(204);

    const rejoinAfterUnban = await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(bob.accessToken));
    expect(rejoinAfterUnban.status).toBe(201);
  });

  // Regression: banning used to resolve its target via
  // findLocalUserByUsername(), which only ever matches a *local*,
  // non-remote user - silently 404ing on a cached remote member even
  // though they're a real member shown in the member list. Fixed to
  // resolve by protocolId, the same way kick/unban already did.
  it("bans a cached remote member by protocolId", async () => {
    const alice = await registerUser("alice");
    const create = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Mod Test" });
    const communityId = create.body.community.id;
    const communityRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: communityId } });

    const remoteBob = await prisma.user.create({
      data: {
        protocolId: "REMOTEBOBPROTOCOLID",
        username: "bob",
        displayName: "Remote Bob",
        homeserverDomain: "bob.invalid",
        isRemote: true,
      },
    });
    await prisma.communityMember.create({ data: { communityId: communityRow.id, userId: remoteBob.id } });

    const ban = await api
      .post(`/api/v1/communities/${communityId}/bans`)
      .set(authHeader(alice.accessToken))
      .send({ protocolId: remoteBob.protocolId });
    expect(ban.status).toBe(204);

    const stillMember = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: communityRow.id, userId: remoteBob.id } },
    });
    expect(stillMember).toBeNull();
  });

  it("refuses to ban the owner", async () => {
    const alice = await registerUser("alice");
    const create = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Mod Test" });
    const communityId = create.body.community.id;

    const ban = await api
      .post(`/api/v1/communities/${communityId}/bans`)
      .set(authHeader(alice.accessToken))
      .send({ protocolId: alice.user.id });
    expect(ban.status).toBe(400);
    expect(ban.body.error).toBe("cannot_ban_owner");
  });

  it("rejects listing bans without BAN_MEMBERS", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const create = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Mod Test" });
    const communityId = create.body.community.id;
    await api.post(`/api/v1/communities/${communityId}/members`).set(authHeader(bob.accessToken));

    const list = await api.get(`/api/v1/communities/${communityId}/bans`).set(authHeader(bob.accessToken));
    expect(list.status).toBe(403);
  });
});

describe("sending into a federated community's channel (local proxy plumbing)", () => {
  const HOME_DOMAIN = "home.invalid";
  let homeServer: Server;
  let homePort: number;
  let responseStatus: number;
  let responseBody: unknown;

  beforeEach(async () => {
    responseStatus = 201;
    responseBody = { message: { id: "RELAYEDMESSAGEID01", content: "hello from home", sender: { username: "alice" } } };
    homeServer = createServer((req, res) => {
      if (req.url === "/.well-known/communication-platform") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "home-key", apiBase: "/federation/v1" } }));
        return;
      }
      res.statusCode = responseStatus;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(responseBody));
    });
    await new Promise<void>((resolve) => homeServer.listen(0, "127.0.0.1", resolve));
    homePort = (homeServer.address() as { port: number }).port;
    config.federationPeerOverrides[HOME_DOMAIN] = `http://127.0.0.1:${homePort}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[HOME_DOMAIN];
    await new Promise<void>((resolve) => homeServer.close(() => resolve()));
  });

  async function seedRemoteChannel(memberId: string) {
    const owner = await prisma.user.create({
      data: {
        protocolId: "REMOTEOWNERID012345",
        username: "remote-owner",
        displayName: "Remote Owner",
        homeserverDomain: HOME_DOMAIN,
        isRemote: true,
      },
    });
    const community = await prisma.community.create({
      data: { protocolId: "REMOTECOMMUNITYID01", name: "Remote", ownerId: owner.id, homeserverDomain: HOME_DOMAIN, isRemote: true },
    });
    const channel = await prisma.channel.create({
      data: { protocolId: "REMOTECHANNELID0123", communityId: community.id, name: "general", position: 0 },
    });
    await prisma.communityMember.create({ data: { communityId: community.id, userId: memberId } });
    return channel;
  }

  it("proxies to the home server and passes its response straight through", async () => {
    const alice = await registerUser("alice");
    const aliceLocal = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const channel = await seedRemoteChannel(aliceLocal.id);

    const res = await api
      .post(`/api/v1/channels/${channel.protocolId}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "can I send this?" });

    expect(res.status).toBe(201);
    expect(res.body.message.content).toBe("hello from home"); // home's response, passed through verbatim
    // No local write - the message reaches our cache later via the ordinary relay.
    expect(await prisma.message.findFirst({ where: { channelId: channel.id } })).toBeNull();
  });

  it("surfaces the home server's rejection (e.g. forbidden) as the same status/body", async () => {
    responseStatus = 403;
    responseBody = { error: "forbidden" };
    const alice = await registerUser("alice");
    const aliceLocal = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const channel = await seedRemoteChannel(aliceLocal.id);

    const res = await api
      .post(`/api/v1/channels/${channel.protocolId}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "not allowed" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("surfaces federation_unreachable when the home server can't be reached", async () => {
    const alice = await registerUser("alice");
    const aliceLocal = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const channel = await seedRemoteChannel(aliceLocal.id);
    delete config.federationPeerOverrides[HOME_DOMAIN];

    const res = await api
      .post(`/api/v1/channels/${channel.protocolId}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "anyone there?" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("federation_unreachable");
  });
});
