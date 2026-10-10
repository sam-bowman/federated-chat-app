// Baseline local (non-federated) community/channel coverage - there was
// none before this feature touched nearly every handler in
// communities/routes.ts and channels/routes.ts, so this exists primarily
// as a regression guard that the federation-awareness added alongside it
// didn't change local-only behavior. Federated behavior itself is covered
// by federationCommunities.test.ts.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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

describe("sending into a federated community's channel (local guard)", () => {
  it("returns 501 instead of writing a local-only message nobody else will see", async () => {
    const alice = await registerUser("alice");
    const owner = await prisma.user.create({
      data: {
        protocolId: "REMOTEOWNERID012345",
        username: "remote-owner",
        displayName: "Remote Owner",
        homeserverDomain: "home.invalid",
        isRemote: true,
      },
    });
    const community = await prisma.community.create({
      data: { protocolId: "REMOTECOMMUNITYID01", name: "Remote", ownerId: owner.id, homeserverDomain: "home.invalid", isRemote: true },
    });
    const channel = await prisma.channel.create({
      data: { protocolId: "REMOTECHANNELID0123", communityId: community.id, name: "general", position: 0 },
    });
    await prisma.communityMember.create({
      data: { communityId: community.id, userId: (await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } })).id },
    });

    const res = await api
      .post(`/api/v1/channels/${channel.protocolId}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "can I send this?" });

    expect(res.status).toBe(501);
    expect(res.body.error).toBe("remote_community_send_not_yet_supported");
    expect(await prisma.message.findFirst({ where: { channelId: channel.id } })).toBeNull();
  });
});
