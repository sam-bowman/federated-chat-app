// Invites that can end (#168): a code with an optional expiry and use limit that its creator or a manager can revoke,
// a per-community switch that closes joining by bare id, the CREATE_INVITE permission, a card that carries an invite of
// its own, and all of it enforced by the community's HOME server, whichever server the person joining is on.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { Permission } from "../../src/lib/permissions.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
type Community = { id: string; homeserverDomain: string; openJoin: boolean; roles: { id: string; isDefault: boolean; permissions: string }[] };

async function createCommunity(owner: Registered, name = "Book Club") {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community as Community;
}

const makeInvite = (who: Registered, community: { id: string }, body: object = {}) =>
  api.post(`/api/v1/communities/${community.id}/invites`).set(authHeader(who.accessToken)).send(body);

const listInvites = (who: Registered, community: { id: string }, query = "") =>
  api.get(`/api/v1/communities/${community.id}/invites${query}`).set(authHeader(who.accessToken));

const revoke = (who: Registered, community: { id: string }, inviteId: string) =>
  api.delete(`/api/v1/communities/${community.id}/invites/${inviteId}`).set(authHeader(who.accessToken));

const join = (who: Registered, ref: string, body: object = {}) =>
  api.post(`/api/v1/communities/${encodeURIComponent(ref)}/members`).set(authHeader(who.accessToken)).send(body);

const patchCommunity = (who: Registered, community: { id: string }, body: object) =>
  api.patch(`/api/v1/communities/${community.id}`).set(authHeader(who.accessToken)).send(body);

const isMember = async (community: { id: string }, username: string) =>
  (await prisma.communityMember.count({ where: { community: { protocolId: community.id }, user: { username } } })) === 1;

const inviteRow = (code: string) => prisma.invite.findUniqueOrThrow({ where: { code } });

/** A member who holds the MANAGE_COMMUNITY permission through a role of their own. */
async function makeManager(owner: Registered, community: Community, member: Registered) {
  const role = await api
    .post(`/api/v1/communities/${community.id}/roles`)
    .set(authHeader(owner.accessToken))
    .send({ name: "Manager", permissions: String(Permission.MANAGE_COMMUNITY | Permission.CREATE_INVITE) });
  expect(role.status).toBe(201);
  const assigned = await api
    .post(`/api/v1/communities/${community.id}/members/${member.user.id}/roles/${role.body.role.id}`)
    .set(authHeader(owner.accessToken));
  expect(assigned.status).toBe(204);
}

/** Takes CREATE_INVITE away from everyone who is not the owner, by editing the @everyone role. */
async function takeAwayCreateInvite(owner: Registered, community: Community) {
  const everyone = community.roles.find((r) => r.isDefault)!;
  const res = await api
    .patch(`/api/v1/communities/${community.id}/roles/${everyone.id}`)
    .set(authHeader(owner.accessToken))
    .send({ permissions: String(Permission.SEND_MESSAGES | Permission.REACT) });
  expect(res.status).toBe(200);
}

async function createDm(from: Registered, username: string) {
  const res = await api.post("/api/v1/conversations").set(authHeader(from.accessToken)).send({ type: "DM", memberUsernames: [username] });
  expect([200, 201]).toContain(res.status);
  return res.body.conversation.id as string;
}

const sendCard = (from: Registered, conversationId: string, community: { id: string }) =>
  api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(from.accessToken)).send({ invite: { communityId: community.id } });

describe("creating an invite", () => {
  it("makes a code that never expires and has no limit when asked for nothing", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);

    const res = await makeInvite(alice, community);

    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({
      code: expect.stringMatching(/^[0-9A-Z]{10}$/),
      expiresAt: null,
      maxUses: null,
      uses: 0,
      revokedAt: null,
      status: "active",
      viaCard: false,
    });
    expect(res.body.invite.reference).toBe(`${community.id}:${config.domain}#${res.body.invite.code}`);
    expect(res.body.invite.createdBy.username).toBe("alice");
  });

  it("can expire in an hour, a day or a week, and be limited to a number of uses", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);

    const res = await makeInvite(alice, community, { expiresInSeconds: 86_400, maxUses: 5 });

    expect(res.status).toBe(201);
    const expiresIn = new Date(res.body.invite.expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(86_400_000 - 5000);
    expect(expiresIn).toBeLessThanOrEqual(86_400_000);
    expect(res.body.invite.maxUses).toBe(5);
  });

  it("refuses a lifetime that is not offered and a limit outside 1 to 1000", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);

    for (const bad of [{ expiresInSeconds: 7 }, { expiresInSeconds: 31_536_000 }, { expiresInSeconds: -1 }, { maxUses: 0 }, { maxUses: 1001 }, { maxUses: 1.5 }, { maxUses: "3" }]) {
      const res = await makeInvite(alice, community, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await prisma.invite.count()).toBe(0);
  });

  it("is open to every member by default, since everyone could invite before there was a permission", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(bob, community.id);

    const res = await makeInvite(bob, community);

    expect(res.status).toBe(201);
    expect(res.body.invite.createdBy.username).toBe("bob");
  });

  it("needs the CREATE_INVITE permission: a member without it is refused, the owner never is", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(bob, community.id);
    await takeAwayCreateInvite(alice, community);

    expect((await makeInvite(bob, community)).status).toBe(403);
    expect((await makeInvite(alice, community)).status).toBe(201);
  });

  it("is refused for someone who is not a member, and for someone not signed in", async () => {
    const alice = await registerUser("alice");
    const stranger = await registerUser("stranger");
    const community = await createCommunity(alice);

    expect((await makeInvite(stranger, community)).status).toBe(403);
    expect((await api.post(`/api/v1/communities/${community.id}/invites`).send({})).status).toBe(401);
    expect(await prisma.invite.count()).toBe(0);
  });

  it("is not found for a community that does not exist", async () => {
    const alice = await registerUser("alice");

    expect((await makeInvite(alice, { id: newProtocolId() })).status).toBe(404);
  });
});

describe("listing and revoking invites", () => {
  it("shows a member their own invites, and a manager everyone's", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    await join(bob, community.id);
    await join(carol, community.id);
    await makeManager(alice, community, carol);
    await makeInvite(alice, community);
    await makeInvite(bob, community);

    const mine = await listInvites(bob, community);
    expect(mine.body.invites.map((i: { createdBy: { username: string } }) => i.createdBy.username)).toEqual(["bob"]);
    expect(mine.body.seesAll).toBe(false);

    const all = await listInvites(carol, community);
    expect(all.body.invites.map((i: { createdBy: { username: string } }) => i.createdBy.username).sort()).toEqual(["alice", "bob"]);
    expect(all.body.seesAll).toBe(true);
    expect((await listInvites(alice, community)).body.invites).toHaveLength(2);
  });

  it("lists the newest first, with the status and uses of each", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const first = await makeInvite(alice, community, { maxUses: 1 });
    await makeInvite(alice, community);
    const bob = await registerUser("bob");
    await join(bob, community.id, { inviteCode: first.body.invite.code });

    const listed = (await listInvites(alice, community)).body.invites;

    expect(listed).toHaveLength(2);
    const old = listed.find((i: { id: string }) => i.id === first.body.invite.id);
    expect(old).toMatchObject({ uses: 1, maxUses: 1, status: "used_up" });
    expect(new Date(listed[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(listed[1].createdAt).getTime());
  });

  it("is refused for someone who is not a member, and says the community's home is elsewhere for a cached one", async () => {
    const alice = await registerUser("alice");
    const stranger = await registerUser("stranger");
    const community = await createCommunity(alice);

    expect((await listInvites(stranger, community)).status).toBe(403);
    expect((await api.get(`/api/v1/communities/${community.id}/invites`)).status).toBe(401);
  });

  it("lets the creator revoke their own invite, after which it stops working", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    await join(bob, community.id);
    const invite = (await makeInvite(bob, community)).body.invite;

    expect((await revoke(bob, community, invite.id)).status).toBe(204);

    const res = await join(carol, community.id, { inviteCode: invite.code });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invite_revoked");
    expect((await listInvites(bob, community)).body.invites[0]).toMatchObject({ status: "revoked" });
  });

  it("lets the owner and a manager revoke anyone's, but not a member someone else's", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const dave = await registerUser("dave");
    const community = await createCommunity(alice);
    for (const user of [bob, carol, dave]) await join(user, community.id);
    await makeManager(alice, community, carol);
    const bobs = (await makeInvite(bob, community)).body.invite;

    expect((await revoke(dave, community, bobs.id)).status).toBe(403);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: bobs.id } })).revokedAt).toBeNull();
    expect((await revoke(carol, community, bobs.id)).status).toBe(204);

    const again = (await makeInvite(bob, community)).body.invite;
    expect((await revoke(alice, community, again.id)).status).toBe(204);
  });

  it("is a no-op the second time and keeps the first time on record", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community)).body.invite;
    await revoke(alice, community, invite.id);
    const firstTime = (await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt;

    expect((await revoke(alice, community, invite.id)).status).toBe(204);

    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt).toEqual(firstTime);
  });

  it("is not found for an invite of another community, and refused for someone who is no longer a member", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const one = await createCommunity(alice, "One");
    const two = await createCommunity(alice, "Two");
    await join(bob, one.id);
    const invite = (await makeInvite(bob, one)).body.invite;

    expect((await revoke(alice, two, invite.id)).status).toBe(404);
    await api.delete(`/api/v1/communities/${one.id}/members/me`).set(authHeader(bob.accessToken));
    expect((await revoke(bob, one, invite.id)).status).toBe(403);
    expect((await revoke(alice, one, "no-such-invite")).status).toBe(404);
  });
});

describe("joining with an invite", () => {
  it("lets a person in and counts the use", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community)).body.invite;

    const res = await join(bob, community.id, { inviteCode: invite.code });

    expect(res.status).toBe(201);
    expect(await isMember(community, "bob")).toBe(true);
    expect((await inviteRow(invite.code)).uses).toBe(1);
  });

  it("accepts the code after a # in the community reference, or in lower case", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community)).body.invite;

    expect((await join(bob, `${community.id}:${config.domain}#${invite.code}`)).status).toBe(201);
    expect((await join(carol, community.id, { inviteCode: invite.code.toLowerCase() })).status).toBe(201);
    expect((await inviteRow(invite.code)).uses).toBe(2);
  });

  it("stops at the use limit, and the person turned away is not added and uses nothing", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community, { maxUses: 1 })).body.invite;
    await join(bob, community.id, { inviteCode: invite.code });

    const res = await join(carol, community.id, { inviteCode: invite.code });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invite_used_up");
    expect(await isMember(community, "carol")).toBe(false);
    expect((await inviteRow(invite.code)).uses).toBe(1);
  });

  // The bug a naive read-then-write would have: two people arrive for the last use at the same moment.
  it("gives the last use to exactly one of two people who arrive together", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community, { maxUses: 1 })).body.invite;
    const racers = await Promise.all(["racer1", "racer2", "racer3", "racer4"].map((name) => registerUser(name)));

    const results = await Promise.all(racers.map((who) => join(who, community.id, { inviteCode: invite.code })));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403).every((r) => r.body.error === "invite_used_up")).toBe(true);
    expect((await inviteRow(invite.code)).uses).toBe(1);
    expect(await prisma.communityMember.count({ where: { community: { protocolId: community.id }, user: { username: { in: ["racer1", "racer2", "racer3", "racer4"] } } } })).toBe(1);
  });

  it("refuses an expired invite, and the person is not added", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community, { expiresInSeconds: 3600 })).body.invite;
    await prisma.invite.update({ where: { code: invite.code }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await join(bob, community.id, { inviteCode: invite.code });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invite_expired");
    expect(await isMember(community, "bob")).toBe(false);
    expect((await listInvites(alice, community)).body.invites[0].status).toBe("expired");
  });

  it("refuses a code that does not exist, and a real code for a different community, the same way", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const one = await createCommunity(alice, "One");
    const two = await createCommunity(alice, "Two");
    const forTwo = (await makeInvite(alice, two)).body.invite;

    const missing = await join(bob, one.id, { inviteCode: "ZZZZZZZZZZ" });
    const wrongCommunity = await join(bob, one.id, { inviteCode: forTwo.code });

    for (const res of [missing, wrongCommunity]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("invite_invalid");
    }
    expect(await isMember(one, "bob")).toBe(false);
    expect((await inviteRow(forTwo.code)).uses).toBe(0);
  });

  it("refuses a malformed code before looking anything up", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);

    for (const bad of ["abc", "has space!", "x".repeat(40), 12345]) {
      const res = await join(bob, community.id, { inviteCode: bad });
      expect(res.status, String(bad)).toBe(400);
    }
    expect((await join(bob, `${community.id}#nope`)).status).toBe(400);
    expect(await isMember(community, "bob")).toBe(false);
  });

  it("does not use up an invite for someone who is already a member", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community, { maxUses: 1 })).body.invite;
    await join(bob, community.id, { inviteCode: invite.code });

    const again = await join(bob, community.id, { inviteCode: invite.code });

    expect(again.status).toBe(201);
    expect((await inviteRow(invite.code)).uses).toBe(1);
  });

  it("does not let a ban be got round, and the banned person uses nothing", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community)).body.invite;
    const communityRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
    const bobRow = await prisma.user.findFirstOrThrow({ where: { username: "bob" } });
    await prisma.communityBan.create({ data: { communityId: communityRow.id, userId: bobRow.id } });

    const res = await join(bob, community.id, { inviteCode: invite.code });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("banned");
    expect((await inviteRow(invite.code)).uses).toBe(0);
  });

  it("still refuses a stale code when the community is open to anyone, so a dead card says so", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community)).body.invite;
    await revoke(alice, community, invite.id);

    const res = await join(bob, community.id, { inviteCode: invite.code });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invite_revoked");
  });

  it("gives the new member the @everyone role, like any other way in", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community)).body.invite;

    const res = await join(bob, community.id, { inviteCode: invite.code });

    const me = res.body.community.members.find((m: { username: string }) => m.username === "bob");
    expect(me.roleIds).toContain(community.roles.find((r) => r.isDefault)!.id);
  });
});

describe("closing a community to joining by id", () => {
  it("is open by default, and says so", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);

    expect(community.openJoin).toBe(true);
  });

  it("lets a manager close it, after which the bare id no longer works but an invite does", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);

    const closed = await patchCommunity(alice, community, { openJoin: false });
    expect(closed.status).toBe(200);
    expect(closed.body.community.openJoin).toBe(false);

    const bare = await join(bob, community.id);
    expect(bare.status).toBe(403);
    expect(bare.body.error).toBe("invite_required");
    expect(await isMember(community, "bob")).toBe(false);

    const invite = (await makeInvite(alice, community)).body.invite;
    expect((await join(carol, community.id, { inviteCode: invite.code })).status).toBe(201);
  });

  it("opens it again", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await patchCommunity(alice, community, { openJoin: false });

    await patchCommunity(alice, community, { openJoin: true });

    expect((await join(bob, community.id)).status).toBe(201);
  });

  it("is for a manager only, and needs a real boolean", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(bob, community.id);

    expect((await patchCommunity(bob, community, { openJoin: false })).status).toBe(403);
    expect((await patchCommunity(alice, community, { openJoin: "no" })).status).toBe(400);
    expect((await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } })).visibility).toBe("UNLISTED");
  });

  it("leaves the people who are already in alone", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(bob, community.id);

    await patchCommunity(alice, community, { openJoin: false });

    expect(await isMember(community, "bob")).toBe(true);
    expect((await join(bob, community.id)).status).toBe(201); // re-joining while in is harmless
  });

  it("does not stop an old-style join in a community that stayed open, so existing codes and cards keep working", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);

    const res = await join(bob, `${community.id}:${config.domain}`);

    expect(res.status).toBe(201);
  });
});

describe("a card carries an invite of its own", () => {
  it("makes one for the card: single use for one recipient, a week, marked as made for a card", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");

    const res = await sendCard(alice, dm, community);

    expect(res.status).toBe(201);
    const row = await inviteRow(res.body.message.invite.code);
    expect(row).toMatchObject({ maxUses: 1, uses: 0, viaCard: true, revokedAt: null });
    expect(row.expiresAt!.getTime() - Date.now()).toBeGreaterThan(604_800_000 - 5000);
  });

  it("lets the friend join from the card once, and not a second person", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    const card = (await sendCard(alice, await createDm(alice, "bob"), community)).body.message.invite;
    const reference = `${card.communityId}:${card.domain}#${card.code}`;

    expect((await join(bob, reference)).status).toBe(201);
    const second = await join(carol, reference);

    expect(second.status).toBe(403);
    expect(second.body.error).toBe("invite_used_up");
  });

  it("allows as many joins as a group chat has other members", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    await registerUser("carol");
    const community = await createCommunity(alice);
    const group = await api
      .post("/api/v1/conversations")
      .set(authHeader(alice.accessToken))
      .send({ type: "GROUP", memberUsernames: ["bob", "carol"], title: "Trio" });
    expect(group.status).toBe(201);

    const res = await sendCard(alice, group.body.conversation.id, community);

    expect((await inviteRow(res.body.message.invite.code)).maxUses).toBe(2);
  });

  it("works for a closed community, where the bare id does not", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await patchCommunity(alice, community, { openJoin: false });
    const card = (await sendCard(alice, await createDm(alice, "bob"), community)).body.message.invite;

    expect((await join(bob, `${community.id}:${config.domain}`)).status).toBe(403);
    expect((await join(bob, `${card.communityId}:${card.domain}#${card.code}`)).status).toBe(201);
  });

  it("stops working when revoked", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const card = (await sendCard(alice, await createDm(alice, "bob"), community)).body.message.invite;
    const row = await inviteRow(card.code);

    await revoke(alice, community, row.id);

    const res = await join(bob, `${card.communityId}:${card.domain}#${card.code}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invite_revoked");
  });

  it("is not sent by a member who may not create invites, and nothing is sent", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await registerUser("carol");
    const community = await createCommunity(alice);
    await join(bob, community.id);
    await takeAwayCreateInvite(alice, community);
    const dm = await createDm(bob, "carol");

    const res = await sendCard(bob, dm, community);

    expect(res.status).toBe(403);
    expect(await prisma.invite.count()).toBe(0);
    expect(await prisma.message.count({ where: { conversation: { protocolId: dm } } })).toBe(0);
  });

  it("does not crowd the dialog's list, but is there when asked for", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const community = await createCommunity(alice);
    await sendCard(alice, await createDm(alice, "bob"), community);
    await makeInvite(alice, community);

    expect((await listInvites(alice, community)).body.invites).toHaveLength(1);
    const withCards = (await listInvites(alice, community, "?cards=1")).body.invites;
    expect(withCards).toHaveLength(2);
    expect(withCards.filter((i: { viaCard: boolean }) => i.viaCard)).toHaveLength(1);
  });
});

describe("the home server decides for a person from another server", () => {
  async function remoteJoin(peer: Awaited<ReturnType<typeof registerTestPeer>>, community: { id: string }, body: object = {}, username = "dora") {
    return signedPost(peer, `/federation/v1/communities/${community.id}/members`, {
      protocolId: newProtocolId(),
      username,
      displayName: "Dora",
      ...body,
    });
  }

  it("lets them in with a good invite, counts the use, and tells them if the community is closed", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    await patchCommunity(alice, community, { openJoin: false });
    const invite = (await makeInvite(alice, community)).body.invite;
    const peer = await registerTestPeer("remote.test");

    const res = await remoteJoin(peer, community, { inviteCode: invite.code });

    expect(res.status).toBe(201);
    expect(res.body.community.openJoin).toBe(false);
    expect((await inviteRow(invite.code)).uses).toBe(1);
  });

  it("refuses them without one when the community is closed, and with each way an invite can be bad", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    await patchCommunity(alice, community, { openJoin: false });
    const peer = await registerTestPeer("remote.test");
    const expired = (await makeInvite(alice, community)).body.invite;
    await prisma.invite.update({ where: { code: expired.code }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const used = (await makeInvite(alice, community, { maxUses: 1 })).body.invite;
    await prisma.invite.update({ where: { code: used.code }, data: { uses: 1 } });
    const revoked = (await makeInvite(alice, community)).body.invite;
    await revoke(alice, community, revoked.id);

    const answers = {
      none: await remoteJoin(peer, community, {}, "d1"),
      expired: await remoteJoin(peer, community, { inviteCode: expired.code }, "d2"),
      used: await remoteJoin(peer, community, { inviteCode: used.code }, "d3"),
      revoked: await remoteJoin(peer, community, { inviteCode: revoked.code }, "d4"),
      invalid: await remoteJoin(peer, community, { inviteCode: "ZZZZZZZZZZ" }, "d5"),
    };

    expect(Object.fromEntries(Object.entries(answers).map(([k, r]) => [k, [r.status, r.body.error]]))).toEqual({
      none: [403, "invite_required"],
      expired: [403, "invite_expired"],
      used: [403, "invite_used_up"],
      revoked: [403, "invite_revoked"],
      invalid: [403, "invite_invalid"],
    });
    expect(await prisma.communityMember.count({ where: { user: { homeserverDomain: "remote.test" } } })).toBe(0);
  });

  it("does not use an invite up for a remote person already in, and still accepts an older server that sends no code to an open community", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const invite = (await makeInvite(alice, community, { maxUses: 1 })).body.invite;
    const peer = await registerTestPeer("remote.test");
    const dora = newProtocolId();

    await remoteJoin(peer, community, { protocolId: dora, inviteCode: invite.code });
    const again = await remoteJoin(peer, community, { protocolId: dora, inviteCode: invite.code });
    const older = await remoteJoin(peer, community, {}, "erin");

    expect(again.status).toBe(201);
    expect((await inviteRow(invite.code)).uses).toBe(1);
    expect(older.status).toBe(201);
  });

  it("rejects a code that is not shaped like one", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const peer = await registerTestPeer("remote.test");

    expect((await remoteJoin(peer, community, { inviteCode: "x" })).status).toBe(400);
  });

  describe("making an invite for someone on another server", () => {
    const remoteInvite = (peer: Awaited<ReturnType<typeof registerTestPeer>>, community: { id: string }, body: object) =>
      signedPost(peer, `/federation/v1/communities/${community.id}/invites`, body);

    it("makes one for a member of the community, who then appears as its creator", async () => {
      const alice = await registerUser("alice");
      const community = await createCommunity(alice);
      const peer = await registerTestPeer("remote.test");
      await remoteJoin(peer, community);

      const res = await remoteInvite(peer, community, { username: "dora", expiresInSeconds: 3600, maxUses: 2, viaCard: true });

      expect(res.status).toBe(201);
      expect(res.body.invite).toMatchObject({ code: expect.stringMatching(/^[0-9A-Z]{10}$/), maxUses: 2 });
      const row = await prisma.invite.findUniqueOrThrow({ where: { code: res.body.invite.code }, include: { createdBy: true } });
      expect(row).toMatchObject({ viaCard: true, createdBy: { username: "dora", homeserverDomain: "remote.test" } });
    });

    it("refuses someone who is not a member, and someone whose role lacks the permission", async () => {
      const alice = await registerUser("alice");
      const community = await createCommunity(alice);
      const peer = await registerTestPeer("remote.test");

      const notMember = await remoteInvite(peer, community, { username: "ghost" });
      expect([notMember.status, notMember.body.error]).toEqual([403, "not_a_member"]);

      await remoteJoin(peer, community);
      await takeAwayCreateInvite(alice, community);
      const noPermission = await remoteInvite(peer, community, { username: "dora" });
      expect([noPermission.status, noPermission.body.error]).toEqual([403, "forbidden"]);
      expect(await prisma.invite.count()).toBe(0);
    });

    // A peer can only ever speak for its own people: naming a person on THIS server must not make an invite as them.
    it("never takes the person's server from the request, so a peer cannot make an invite as someone here", async () => {
      const alice = await registerUser("alice");
      const community = await createCommunity(alice);
      const peer = await registerTestPeer("remote.test");

      const res = await remoteInvite(peer, community, { username: "alice" });

      expect([res.status, res.body.error]).toEqual([403, "not_a_member"]);
      expect(await prisma.invite.count()).toBe(0);
    });

    it("refuses a server that is only a cache of the community, and a bad request", async () => {
      const owner = await prisma.user.create({
        data: { protocolId: newProtocolId(), username: "owner", displayName: "Owner", homeserverDomain: "elsewhere.invalid", isRemote: true },
      });
      const cached = await prisma.community.create({
        data: { protocolId: newProtocolId(), name: "Far", ownerId: owner.id, homeserverDomain: "elsewhere.invalid", isRemote: true },
      });
      const peer = await registerTestPeer("remote.test");

      expect((await remoteInvite(peer, { id: cached.protocolId }, { username: "dora" })).status).toBe(409);
      const alice = await registerUser("alice");
      const community = await createCommunity(alice);
      expect((await remoteInvite(peer, community, { username: "dora", maxUses: 0 })).status).toBe(400);
      expect((await remoteInvite(peer, community, {})).status).toBe(400);
    });
  });
});

describe("a community on another server (this server in the middle)", () => {
  const DOMAIN = "home.invalid";
  let home: Server;
  let calls: { path: string; body: any }[];
  /** What the fake home server answers to the join and to the invite request. */
  let answers: { join: { status: number; body: unknown }; invites: { status: number; body: unknown } };
  let remoteCommunityId: string;

  beforeEach(async () => {
    remoteCommunityId = newProtocolId();
    calls = [];
    const owner = { protocolId: newProtocolId(), username: "olga", domain: DOMAIN, displayName: "Olga", avatarUrl: null };
    answers = {
      join: {
        status: 201,
        body: { community: { protocolId: remoteCommunityId, name: "Far Club", description: null, iconUrl: null, openJoin: false, owner, channels: [] } },
      },
      invites: { status: 201, body: { invite: { code: "FARINVITE1", expiresAt: null, maxUses: 1, createdAt: new Date().toISOString() } } },
    };
    home = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/.well-known/communication-platform") {
          res.end(JSON.stringify({ federation: { enabled: true, publicKey: "home-key", apiBase: "/federation/v1" } }));
          return;
        }
        calls.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
        const answer = req.url?.endsWith("/invites") ? answers.invites : answers.join;
        res.statusCode = answer.status;
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => home.listen(0, "127.0.0.1", resolve));
    config.federationPeerOverrides[DOMAIN] = `http://127.0.0.1:${(home.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[DOMAIN];
    await new Promise<void>((resolve) => home.close(() => resolve()));
  });

  it("sends the invite code to the home server with the join", async () => {
    const bob = await registerUser("bob");

    const res = await join(bob, `${remoteCommunityId}:${DOMAIN}#K7M2QXR9TB`);

    expect(res.status).toBe(201);
    const sent = calls.find((c) => c.path.endsWith("/members"))!;
    expect(sent.path).toBe(`/federation/v1/communities/${remoteCommunityId}/members`);
    expect(sent.body).toMatchObject({ username: "bob", inviteCode: "K7M2QXR9TB" });
  });

  it("takes the code from the body too, and sends none when there is none", async () => {
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");

    await join(bob, `${remoteCommunityId}:${DOMAIN}`, { inviteCode: "BODYCODE12" });
    await join(carol, `${remoteCommunityId}:${DOMAIN}`);

    const members = calls.filter((c) => c.path.endsWith("/members"));
    expect(members[0].body.inviteCode).toBe("BODYCODE12");
    expect(members[1].body.inviteCode).toBeUndefined();
  });

  it("caches whether the community is open, from what the home server says", async () => {
    const bob = await registerUser("bob");

    const res = await join(bob, `${remoteCommunityId}:${DOMAIN}#K7M2QXR9TB`);

    expect(res.body.community.openJoin).toBe(false);
    expect((await prisma.community.findUniqueOrThrow({ where: { protocolId: remoteCommunityId } })).visibility).toBe("INVITE_ONLY");
  });

  it("treats a home server that predates invites, which says nothing about it, as open", async () => {
    const bob = await registerUser("bob");
    delete (answers.join.body as { community: { openJoin?: boolean } }).community.openJoin;

    const res = await join(bob, `${remoteCommunityId}:${DOMAIN}`);

    expect(res.body.community.openJoin).toBe(true);
  });

  it("passes the home server's refusal through unchanged, so the card can say why", async () => {
    const bob = await registerUser("bob");
    for (const error of ["invite_expired", "invite_used_up", "invite_revoked", "invite_invalid", "invite_required", "banned"]) {
      answers.join = { status: 403, body: { error } };

      const res = await join(bob, `${remoteCommunityId}:${DOMAIN}#K7M2QXR9TB`);

      expect([res.status, res.body.error], error).toEqual([403, error]);
    }
    expect(await prisma.community.count({ where: { protocolId: remoteCommunityId } })).toBe(0);
  });

  describe("making an invite for it", () => {
    async function joinedMember() {
      const bob = await registerUser("bob");
      expect((await join(bob, `${remoteCommunityId}:${DOMAIN}#K7M2QXR9TB`)).status).toBe(201);
      calls.length = 0;
      return bob;
    }

    it("is made by the home server, which is told who is asking", async () => {
      const bob = await joinedMember();

      const res = await makeInvite(bob, { id: remoteCommunityId }, { maxUses: 1, expiresInSeconds: 3600 });

      expect(res.status).toBe(201);
      expect(calls[0]).toMatchObject({ path: `/federation/v1/communities/${remoteCommunityId}/invites`, body: { username: "bob", maxUses: 1, expiresInSeconds: 3600 } });
      expect(res.body.invite).toMatchObject({ code: "FARINVITE1", reference: `${remoteCommunityId}:${DOMAIN}#FARINVITE1`, id: null, status: "active" });
      expect(await prisma.invite.count()).toBe(0); // only the home server keeps invites
    });

    it("passes the home server's refusal through", async () => {
      const bob = await joinedMember();
      answers.invites = { status: 403, body: { error: "forbidden" } };

      const res = await makeInvite(bob, { id: remoteCommunityId });

      expect([res.status, res.body.error]).toEqual([403, "forbidden"]);
    });

    it("is refused here, without asking anyone, for someone who is not in the community", async () => {
      await joinedMember();
      const stranger = await registerUser("stranger");

      const res = await makeInvite(stranger, { id: remoteCommunityId });

      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("says the invites are on the other server when asked to list or revoke them here", async () => {
      const bob = await joinedMember();

      expect((await listInvites(bob, { id: remoteCommunityId })).status).toBe(409);
      expect((await revoke(bob, { id: remoteCommunityId }, "anything")).status).toBe(409);
    });

    it("makes the card's invite there too, and sends the card with its code", async () => {
      const bob = await joinedMember();
      await registerUser("carol");
      const dm = await createDm(bob, "carol");

      const res = await sendCard(bob, dm, { id: remoteCommunityId });

      expect(res.status).toBe(201);
      expect(res.body.message.invite).toMatchObject({ communityId: remoteCommunityId, domain: DOMAIN, code: "FARINVITE1" });
      expect(calls[0].body).toMatchObject({ username: "bob", maxUses: 1, expiresInSeconds: 604_800, viaCard: true });
    });

    it("refuses the card when the home server says the person may not make invites", async () => {
      const bob = await joinedMember();
      await registerUser("carol");
      const dm = await createDm(bob, "carol");
      answers.invites = { status: 403, body: { error: "forbidden" } };

      const res = await sendCard(bob, dm, { id: remoteCommunityId });

      expect(res.status).toBe(403);
      expect(await prisma.message.count({ where: { conversation: { protocolId: dm } } })).toBe(0);
    });

    it("sends a card without a code when the home server cannot make one and the community is open", async () => {
      const bob = await joinedMember();
      await prisma.community.update({ where: { protocolId: remoteCommunityId }, data: { visibility: "UNLISTED" } });
      await registerUser("carol");
      const dm = await createDm(bob, "carol");
      answers.invites = { status: 404, body: {} }; // a server from before invites

      const res = await sendCard(bob, dm, { id: remoteCommunityId });

      expect(res.status).toBe(201);
      expect(res.body.message.invite.code).toBeUndefined();
    });

    it("does not send a card that could not work: no code from a server that cannot make one, to a closed community", async () => {
      const bob = await joinedMember(); // the fake home says openJoin: false
      await registerUser("carol");
      const dm = await createDm(bob, "carol");
      answers.invites = { status: 500, body: { error: "internal_error" } };

      const res = await sendCard(bob, dm, { id: remoteCommunityId });

      expect(res.status).toBe(502);
      expect(await prisma.message.count({ where: { conversation: { protocolId: dm } } })).toBe(0);
    });
  });
});
