// Channel management: rename/topic, reorder, delete. Deleting is permanent -
// it takes every message in the channel with it - so the guards matter: a
// community always keeps one channel, and a channel id is only ever honoured
// within the community it's addressed through.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { Permission } from "../../src/lib/permissions.js";
import { api } from "../helpers/app.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
type Channel = { id: string; name: string; topic: string | null; position: number };

async function createCommunity(owner: Registered, name = "Channels Test") {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community as { id: string; channels: Channel[] };
}

async function join(community: { id: string }, user: Registered) {
  expect((await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken))).status).toBe(201);
}

async function addChannel(owner: Registered, community: { id: string }, name: string) {
  const res = await api.post(`/api/v1/communities/${community.id}/channels`).set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.channel as Channel;
}

const patchChannel = (token: string, communityId: string, channelId: string, body: object) =>
  api.patch(`/api/v1/communities/${communityId}/channels/${channelId}`).set(authHeader(token)).send(body);
const deleteChannel = (token: string, communityId: string, channelId: string) =>
  api.delete(`/api/v1/communities/${communityId}/channels/${channelId}`).set(authHeader(token));
const reorder = (token: string, communityId: string, order: unknown) =>
  api.put(`/api/v1/communities/${communityId}/channels/order`).set(authHeader(token)).send({ order });

async function channelNames(token: string, communityId: string) {
  const res = await api.get(`/api/v1/communities/${communityId}`).set(authHeader(token));
  return (res.body.community.channels as Channel[]).map((c) => c.name);
}

async function channelPositions(communityId: string) {
  const community = await prisma.community.findUniqueOrThrow({ where: { protocolId: communityId } });
  const rows = await prisma.channel.findMany({ where: { communityId: community.id }, orderBy: { position: "asc" } });
  return rows.map((r) => ({ name: r.name, position: r.position }));
}

// A member with MANAGE_CHANNELS (and nothing else), via the role API.
async function makeChannelManager(owner: Registered, community: { id: string }, member: Registered) {
  const role = await api
    .post(`/api/v1/communities/${community.id}/roles`)
    .set(authHeader(owner.accessToken))
    .send({ name: "Channel Manager", permissions: Permission.MANAGE_CHANNELS.toString() });
  expect(role.status).toBe(201);
  const assign = await api
    .post(`/api/v1/communities/${community.id}/members/${member.user.id}/roles/${role.body.role.id}`)
    .set(authHeader(owner.accessToken));
  expect(assign.status).toBe(204);
}

describe("renaming and re-topicking", () => {
  it("lets the owner rename a channel and set, change and clear its topic", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const general = community.channels[0];

    const renamed = await patchChannel(alice.accessToken, community.id, general.id, { name: "lobby", topic: "Say hi" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.channel).toMatchObject({ id: general.id, name: "lobby", topic: "Say hi" });

    const nameOnly = await patchChannel(alice.accessToken, community.id, general.id, { name: "hall" });
    expect(nameOnly.body.channel).toMatchObject({ name: "hall", topic: "Say hi" }); // untouched

    expect((await patchChannel(alice.accessToken, community.id, general.id, { topic: null })).body.channel.topic).toBeNull();
    await patchChannel(alice.accessToken, community.id, general.id, { topic: "again" });
    expect((await patchChannel(alice.accessToken, community.id, general.id, { topic: "" })).body.channel.topic).toBeNull(); // blank clears it
  });

  it("rejects an empty or invalid edit", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const id = community.channels[0].id;
    const edit = (body: object) => patchChannel(alice.accessToken, community.id, id, body);

    expect((await edit({})).status).toBe(400);
    expect((await edit({ name: "" })).status).toBe(400);
    expect((await edit({ name: "x".repeat(51) })).status).toBe(400);
    expect((await edit({ topic: "x".repeat(257) })).status).toBe(400);
    expect((await channelNames(alice.accessToken, community.id))).toEqual(["general"]);
  });

  it("only honours a channel id within its own community", async () => {
    const alice = await registerUser("alice");
    const dave = await registerUser("dave");
    const mine = await createCommunity(alice, "Mine");
    const theirs = await createCommunity(dave, "Theirs");
    const foreign = theirs.channels[0];

    const edit = await patchChannel(alice.accessToken, mine.id, foreign.id, { name: "hijacked" });
    expect(edit.status).toBe(404);
    expect(edit.body.error).toBe("channel_not_found");
    expect((await deleteChannel(alice.accessToken, mine.id, foreign.id)).status).toBe(404);

    expect(await channelNames(dave.accessToken, theirs.id)).toEqual(["general"]);
    expect((await patchChannel(alice.accessToken, mine.id, "NOSUCHCHANNEL", { name: "x" })).status).toBe(404);
  });

  it("needs MANAGE_CHANNELS: refused for an ordinary member, allowed for a delegated manager", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    await join(community, bob);
    await join(community, carol);
    const id = community.channels[0].id;
    await makeChannelManager(alice, community, carol);

    expect((await patchChannel(bob.accessToken, community.id, id, { name: "nope" })).status).toBe(403);
    expect((await deleteChannel(bob.accessToken, community.id, id)).status).toBe(403);
    expect((await reorder(bob.accessToken, community.id, [id])).status).toBe(403);

    expect((await patchChannel(carol.accessToken, community.id, id, { name: "carols" })).status).toBe(200);
  });

  it("tells every local member to refresh", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);
    const bobRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: bob.user.id } });
    const count = () => prisma.syncEvent.count({ where: { recipientId: bobRow.id, type: "community:updated" } });
    const before = await count();

    await patchChannel(alice.accessToken, community.id, community.channels[0].id, { name: "renamed" });

    expect(await count()).toBe(before + 1);
  });
});

describe("deleting", () => {
  it("permanently removes the channel and its messages, leaving other channels alone", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const general = community.channels[0];
    const extra = await addChannel(alice, community, "extra");
    for (const ch of [general, extra]) {
      await api.post(`/api/v1/channels/${ch.id}/messages`).set(authHeader(alice.accessToken)).send({ content: `in ${ch.name}` });
    }
    await api.post(`/api/v1/channels/${extra.id}/read`).set(authHeader(alice.accessToken));

    const res = await deleteChannel(alice.accessToken, community.id, extra.id);

    expect(res.status).toBe(204);
    expect(await channelNames(alice.accessToken, community.id)).toEqual(["general"]);
    const extraRow = await prisma.channel.findUnique({ where: { protocolId: extra.id } });
    expect(extraRow).toBeNull();
    const surviving = await prisma.message.findMany({ select: { content: true } });
    expect(surviving.map((m) => m.content)).toEqual(["in general"]); // extra's message went with it
    expect(await prisma.channelRead.count()).toBe(0);
  });

  it("won't delete the last channel", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);

    const res = await deleteChannel(alice.accessToken, community.id, community.channels[0].id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("last_channel");
    expect(await channelNames(alice.accessToken, community.id)).toEqual(["general"]);
  });

  // Channel creation assigns position by count, so deleting from the middle
  // without closing the gap would hand the next new channel a position that's
  // already taken.
  it("keeps positions contiguous, so a channel created afterwards doesn't collide", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    await addChannel(alice, community, "a");
    await addChannel(alice, community, "b");
    expect(await channelPositions(community.id)).toEqual([
      { name: "general", position: 0 },
      { name: "a", position: 1 },
      { name: "b", position: 2 },
    ]);

    expect((await deleteChannel(alice.accessToken, community.id, community.channels[0].id)).status).toBe(204);
    expect(await channelPositions(community.id)).toEqual([
      { name: "a", position: 0 },
      { name: "b", position: 1 },
    ]);

    await addChannel(alice, community, "c");
    expect(await channelPositions(community.id)).toEqual([
      { name: "a", position: 0 },
      { name: "b", position: 1 },
      { name: "c", position: 2 },
    ]);
  });

  it("resyncs a federated member's server, which drops the channel from its cache", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const extra = await addChannel(alice, community, "extra");
    const communityRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
    const remote = await prisma.user.create({
      data: { protocolId: "REMOTEMEMBERID012345", username: "carol", displayName: "Carol", homeserverDomain: "carol.invalid", isRemote: true },
    });
    await prisma.communityMember.create({ data: { communityId: communityRow.id, userId: remote.id } });

    await deleteChannel(alice.accessToken, community.id, extra.id);

    const pings = await prisma.federationOutboxEvent.findMany({
      where: { domain: "carol.invalid", path: `/communities/${community.id}/updated` },
    });
    expect(pings.length).toBeGreaterThanOrEqual(1);
  });
});

describe("reordering", () => {
  it("applies a new order that every member then sees", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);
    const a = await addChannel(alice, community, "a");
    const b = await addChannel(alice, community, "b");
    const general = community.channels[0];

    const res = await reorder(alice.accessToken, community.id, [b.id, general.id, a.id]);

    expect(res.status).toBe(200);
    expect(res.body.channels.map((c: Channel) => [c.name, c.position])).toEqual([["b", 0], ["general", 1], ["a", 2]]);
    expect(await channelNames(bob.accessToken, community.id)).toEqual(["b", "general", "a"]);
    expect(await channelPositions(community.id)).toEqual([
      { name: "b", position: 0 },
      { name: "general", position: 1 },
      { name: "a", position: 2 },
    ]);
  });

  it("rejects anything that isn't exactly the community's channels, each once - and changes nothing", async () => {
    const alice = await registerUser("alice");
    const dave = await registerUser("dave");
    const community = await createCommunity(alice);
    const other = await createCommunity(dave, "Other");
    const a = await addChannel(alice, community, "a");
    const general = community.channels[0];
    const bad = async (order: unknown) => (await reorder(alice.accessToken, community.id, order)).status;

    expect(await bad([general.id])).toBe(400); // one missing
    expect(await bad([general.id, a.id, other.channels[0].id])).toBe(400); // an extra, from another community
    expect(await bad([general.id, other.channels[0].id])).toBe(400); // right length, wrong channel
    expect(await bad([general.id, general.id])).toBe(400); // a duplicate
    expect(await bad([])).toBe(400);
    expect(await bad("not-an-array")).toBe(400);

    expect(await channelNames(alice.accessToken, community.id)).toEqual(["general", "a"]);
  });

  it("resyncs federated members so their cached order follows", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const a = await addChannel(alice, community, "a");
    const communityRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
    const remote = await prisma.user.create({
      data: { protocolId: "REMOTEMEMBERID012345", username: "carol", displayName: "Carol", homeserverDomain: "carol.invalid", isRemote: true },
    });
    await prisma.communityMember.create({ data: { communityId: communityRow.id, userId: remote.id } });

    await reorder(alice.accessToken, community.id, [a.id, community.channels[0].id]);

    const pings = await prisma.federationOutboxEvent.findMany({
      where: { domain: "carol.invalid", path: `/communities/${community.id}/updated` },
    });
    expect(pings.length).toBeGreaterThanOrEqual(1);
  });
});

describe("a community hosted on another server", () => {
  it("can't have its channels managed from here", async () => {
    const alice = await registerUser("alice");
    const aliceRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const remoteOwner = await prisma.user.create({
      data: { protocolId: "REMOTEOWNERID012345", username: "remote-owner", displayName: "R", homeserverDomain: "home.invalid", isRemote: true },
    });
    const remote = await prisma.community.create({
      data: { protocolId: "REMOTECOMMUNITYID01", name: "Remote", ownerId: remoteOwner.id, homeserverDomain: "home.invalid", isRemote: true },
    });
    const channel = await prisma.channel.create({
      data: { protocolId: "REMOTECHANNELID0123", communityId: remote.id, name: "general", position: 0 },
    });
    await prisma.communityMember.create({ data: { communityId: remote.id, userId: aliceRow.id } });

    expect((await patchChannel(alice.accessToken, remote.protocolId, channel.protocolId, { name: "x" })).status).toBe(409);
    expect((await deleteChannel(alice.accessToken, remote.protocolId, channel.protocolId)).status).toBe(409);
    expect((await reorder(alice.accessToken, remote.protocolId, [channel.protocolId])).status).toBe(409);
  });
});
