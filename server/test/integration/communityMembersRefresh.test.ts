// Regression test for #220: someone who joins a community after another member loaded the app was missing from that member's
// voice channel list, because nothing told that member's client to refresh its cached member list. Every change to who is IN a
// community (join, leave, kick, ban, here and from another server) now tells the people already in it, the way a role or channel
// change already did (`community:updated`).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;

async function createCommunity(owner: Registered) {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name: "Members Refresh" });
  expect(res.status).toBe(201);
  return res.body.community as { id: string };
}
const join = (community: { id: string }, user: Registered) => api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken));

/** How many times this person has been told to refresh their communities. */
async function refreshes(user: Registered) {
  const row = await prisma.user.findUniqueOrThrow({ where: { protocolId: user.user.id } });
  return prisma.syncEvent.count({ where: { recipientId: row.id, type: "community:updated" } });
}

describe("telling the people already in a community that its members changed", () => {
  it("tells them when someone joins", async () => {
    const owner = await registerUser("olive");
    const bystander = await registerUser("sam");
    const newcomer = await registerUser("max");
    const community = await createCommunity(owner);
    expect((await join(community, bystander)).status).toBe(201);
    const before = await refreshes(bystander);

    expect((await join(community, newcomer)).status).toBe(201);

    expect(await refreshes(bystander)).toBe(before + 1);
    expect(await refreshes(owner)).toBeGreaterThan(0);
  });

  it("does not tell anyone again when someone who is already in joins again", async () => {
    const owner = await registerUser("olive");
    const bystander = await registerUser("sam");
    const community = await createCommunity(owner);
    await join(community, bystander);
    const before = await refreshes(owner);
    expect((await join(community, bystander)).status).toBe(201);
    expect(await refreshes(owner)).toBe(before);
  });

  it("does not tell anyone about a join that was refused", async () => {
    const owner = await registerUser("olive");
    const stranger = await registerUser("max");
    const community = await createCommunity(owner);
    await prisma.communityBan.create({
      data: { communityId: (await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } })).id, userId: (await prisma.user.findUniqueOrThrow({ where: { protocolId: stranger.user.id } })).id },
    });
    const before = await refreshes(owner);
    expect((await join(community, stranger)).status).toBeGreaterThanOrEqual(400);
    expect(await refreshes(owner)).toBe(before);
  });

  it("tells them when someone leaves", async () => {
    const owner = await registerUser("olive");
    const leaver = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, leaver);
    const before = await refreshes(owner);

    expect((await api.delete(`/api/v1/communities/${community.id}/members/me`).set(authHeader(leaver.accessToken))).status).toBe(204);

    expect(await refreshes(owner)).toBe(before + 1);
  });

  it("tells them when someone is kicked", async () => {
    const owner = await registerUser("olive");
    const bystander = await registerUser("sam");
    const target = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, bystander);
    await join(community, target);
    const before = await refreshes(bystander);

    expect((await api.delete(`/api/v1/communities/${community.id}/members/${target.user.id}`).set(authHeader(owner.accessToken))).status).toBe(204);

    expect(await refreshes(bystander)).toBe(before + 1);
  });

  it("tells them when someone is banned", async () => {
    const owner = await registerUser("olive");
    const bystander = await registerUser("sam");
    const target = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, bystander);
    await join(community, target);
    const before = await refreshes(bystander);

    const res = await api.post(`/api/v1/communities/${community.id}/bans`).set(authHeader(owner.accessToken)).send({ protocolId: target.user.id });
    expect(res.status).toBe(204);

    expect(await refreshes(bystander)).toBe(before + 1);
  });

  it("tells them when someone from another server joins, and when they leave", async () => {
    const owner = await registerUser("olive");
    const community = await createCommunity(owner);
    const far = await registerTestPeer("far.test");
    const before = await refreshes(owner);

    const joined = await signedPost(far, `/federation/v1/communities/${community.id}/members`, { protocolId: newProtocolId(), username: "fran", displayName: "Fran" });
    expect(joined.status).toBe(201);
    expect(await refreshes(owner)).toBe(before + 1);

    const left = await signedPost(far, `/federation/v1/communities/${community.id}/members/leave`, { username: "fran" });
    expect(left.status).toBe(204);
    expect(await refreshes(owner)).toBe(before + 2);
  });
});
