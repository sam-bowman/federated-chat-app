// DELETE_MESSAGES, REACT and MANAGE_EMOTICONS used to be defined but checked by nothing, so granting
// or withholding them did nothing (see #73). These tests exercise each one for real - through the
// local API and through the home-side federation handlers a remote member's server calls - and pin
// the rules that matter: a moderator can remove someone else's message but a DM stays sender-only,
// a bit held in one community is never usable on another's messages, and a non-member holds nothing.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { Permission } from "../../src/lib/permissions.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
type Community = { id: string; channels: { id: string }[]; roles: { id: string; name: string; isDefault: boolean }[] };
const perms = (...bits: bigint[]) => bits.reduce((a, b) => a | b, 0n).toString();

async function createCommunity(owner: Registered, name = "Moderation Test"): Promise<Community> {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community;
}

async function join(community: Community, user: Registered) {
  const res = await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken));
  expect(res.status).toBe(201);
}

/** Gives `user` a new role carrying exactly these bits. */
async function grant(owner: Registered, community: Community, userId: string, ...bits: bigint[]) {
  const role = await api
    .post(`/api/v1/communities/${community.id}/roles`)
    .set(authHeader(owner.accessToken))
    .send({ name: `role-${bits.length}-${newProtocolId().slice(-4)}`, color: "#112233", permissions: perms(...bits) });
  expect(role.status).toBe(201);
  const assigned = await api
    .post(`/api/v1/communities/${community.id}/members/${userId}/roles/${role.body.role.id}`)
    .set(authHeader(owner.accessToken));
  expect(assigned.status).toBeLessThan(300);
}

async function postMessage(user: Registered, community: Community, content = "hello") {
  const res = await api
    .post(`/api/v1/channels/${community.channels[0].id}/messages`)
    .set(authHeader(user.accessToken))
    .send({ content });
  expect(res.status).toBe(201);
  return res.body.message.id as string;
}

const del = (user: Registered, messageId: string) =>
  api.delete(`/api/v1/messages/${messageId}`).set(authHeader(user.accessToken));
const react = (user: Registered, messageId: string, emoji = "👍") =>
  api.post(`/api/v1/messages/${messageId}/reactions`).set(authHeader(user.accessToken)).send({ emoji });
const unreact = (user: Registered, messageId: string, emoji = "👍") =>
  api.delete(`/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`).set(authHeader(user.accessToken));

async function isDeleted(protocolId: string) {
  return (await prisma.message.findUniqueOrThrow({ where: { protocolId } })).deletedAt !== null;
}

describe("DELETE_MESSAGES (local)", () => {
  it("lets a moderator delete someone else's message, and nobody else", async () => {
    const owner = await registerUser("owner");
    const mod = await registerUser("mod");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(owner);
    for (const u of [mod, bob, carol]) await join(community, u);
    await grant(owner, community, mod.user.id, Permission.DELETE_MESSAGES);

    const bobsMessage = await postMessage(bob, community, "bob's words");

    // A plain member cannot remove another member's message.
    expect((await del(carol, bobsMessage)).status).toBe(403);
    expect(await isDeleted(bobsMessage)).toBe(false);

    // The moderator can - and so can the owner, who holds every permission.
    expect((await del(mod, bobsMessage)).status).toBe(204);
    expect(await isDeleted(bobsMessage)).toBe(true);
    const another = await postMessage(bob, community, "another");
    expect((await del(owner, another)).status).toBe(204);
  });

  it("still lets anyone delete their own message, with no permission at all", async () => {
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const community = await createCommunity(owner);
    await join(community, bob);
    const mine = await postMessage(bob, community);
    expect((await del(bob, mine)).status).toBe(204);
  });

  it("does not stretch to a DM: holding the bit in a community gives no power over a conversation", async () => {
    const owner = await registerUser("owner");
    const mod = await registerUser("mod");
    const bob = await registerUser("bob");
    const community = await createCommunity(owner);
    await join(community, mod);
    await grant(owner, community, mod.user.id, Permission.DELETE_MESSAGES);

    const dm = await api
      .post("/api/v1/conversations")
      .set(authHeader(bob.accessToken))
      .send({ type: "DM", memberUsernames: ["mod"] });
    expect(dm.status).toBe(201);
    const sent = await api
      .post(`/api/v1/conversations/${dm.body.conversation.id}/messages`)
      .set(authHeader(bob.accessToken))
      .send({ content: "private" });
    expect(sent.status).toBe(201);

    expect((await del(mod, sent.body.message.id)).status).toBe(403);
    expect(await isDeleted(sent.body.message.id)).toBe(false);
  });

  it("is per community: the bit held in one community is useless on another's messages", async () => {
    const owner = await registerUser("owner");
    const mod = await registerUser("mod");
    const bob = await registerUser("bob");
    const a = await createCommunity(owner, "A");
    const b = await createCommunity(owner, "B");
    await join(a, mod);
    await join(b, mod);
    await join(b, bob);
    await grant(owner, a, mod.user.id, Permission.DELETE_MESSAGES); // moderator of A only

    const inB = await postMessage(bob, b);
    expect((await del(mod, inB)).status).toBe(403);
    expect(await isDeleted(inB)).toBe(false);
  });
});

describe("REACT (local)", () => {
  it("is held by every member through the default role, so reacting keeps working", async () => {
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const community = await createCommunity(owner);
    await join(community, bob);
    const message = await postMessage(owner, community);
    const res = await react(bob, message);
    expect(res.status).toBe(200);
    expect(res.body.message.reactions).toEqual([{ emoji: "👍", count: 1, users: ["bob"] }]);
  });

  it("blocks adding a reaction once the default role loses REACT, but never removing your own", async () => {
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const community = await createCommunity(owner);
    await join(community, bob);
    const message = await postMessage(owner, community);
    expect((await react(bob, message)).status).toBe(200);

    const everyone = community.roles.find((r) => r.isDefault)!;
    const patch = await api
      .patch(`/api/v1/communities/${community.id}/roles/${everyone.id}`)
      .set(authHeader(owner.accessToken))
      .send({ name: everyone.name, permissions: perms(Permission.SEND_MESSAGES) });
    expect(patch.status).toBe(200);

    // Withholding REACT now actually does something...
    expect((await react(bob, message, "🎉")).status).toBe(403);
    // ...sending is untouched, and bob can still take back the reaction he already made.
    expect((await api.post(`/api/v1/channels/${community.channels[0].id}/messages`).set(authHeader(bob.accessToken)).send({ content: "still here" })).status).toBe(201);
    expect((await unreact(bob, message)).status).toBe(200);
  });

  it("refuses a non-member, who holds no permissions at all (it used to be allowed)", async () => {
    const owner = await registerUser("owner");
    const stranger = await registerUser("stranger");
    const community = await createCommunity(owner);
    const message = await postMessage(owner, community);
    expect((await react(stranger, message)).status).toBe(403);
    expect(await prisma.reaction.count()).toBe(0);
  });
});

describe("MANAGE_EMOTICONS", () => {
  async function communityEmoticon(creator: Registered, community: Community) {
    const res = await api
      .post("/api/v1/emoticons")
      .set(authHeader(creator.accessToken))
      .send({ name: "party", trigger: ":party:", imageUrl: "/uploads/party.png", communityId: community.id });
    expect(res.status).toBe(201);
    return res.body.emoticon.id as string;
  }
  const edit = (user: Registered, id: string) =>
    api.patch(`/api/v1/emoticons/${id}`).set(authHeader(user.accessToken)).send({ name: "renamed" });
  const remove = (user: Registered, id: string) => api.delete(`/api/v1/emoticons/${id}`).set(authHeader(user.accessToken));

  it("lets a holder edit and delete a community's emoticon they did not create, and nobody else", async () => {
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const curator = await registerUser("curator");
    const community = await createCommunity(owner);
    for (const u of [bob, carol, curator]) await join(community, u);
    await grant(owner, community, curator.user.id, Permission.MANAGE_EMOTICONS);

    const emoticon = await communityEmoticon(bob, community);

    expect((await edit(carol, emoticon)).status).toBe(403);
    expect((await remove(carol, emoticon)).status).toBe(403);

    expect((await edit(curator, emoticon)).status).toBe(200);
    expect((await prisma.emoticon.findUniqueOrThrow({ where: { protocolId: emoticon } })).name).toBe("renamed");
    expect((await remove(curator, emoticon)).status).toBe(204);
    expect(await prisma.emoticon.count({ where: { protocolId: emoticon } })).toBe(0);

    // The creator and the owner never needed the bit.
    const again = await communityEmoticon(bob, community);
    expect((await edit(bob, again)).status).toBe(200);
    expect((await remove(owner, again)).status).toBe(204);
  });

  it("does not reach a personal emoticon, whatever role the caller holds", async () => {
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const curator = await registerUser("curator");
    const community = await createCommunity(owner);
    await join(community, curator);
    await grant(owner, community, curator.user.id, Permission.MANAGE_EMOTICONS);

    const personal = await api
      .post("/api/v1/emoticons")
      .set(authHeader(bob.accessToken))
      .send({ name: "mine", trigger: ":mine:", imageUrl: "/uploads/mine.png" });
    expect(personal.status).toBe(201);
    expect((await edit(curator, personal.body.emoticon.id)).status).toBe(403);
    expect((await remove(curator, personal.body.emoticon.id)).status).toBe(403);
  });

  it("is per community: the bit held in one community does nothing in another", async () => {
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const curator = await registerUser("curator");
    const a = await createCommunity(owner, "A");
    const b = await createCommunity(owner, "B");
    await join(a, curator);
    await join(b, curator);
    await join(b, bob);
    await grant(owner, a, curator.user.id, Permission.MANAGE_EMOTICONS);
    const inB = await communityEmoticon(bob, b);
    expect((await edit(curator, inB)).status).toBe(403);
  });
});

// The home server's side of a remote member's actions: another server calls these with a signed request
// naming the member. The permission is the member's role HERE, and the message has to be in the
// community and channel the URL names.
describe("DELETE_MESSAGES and REACT through the federation home-side handlers", () => {
  const base = (community: Community) => `/federation/v1/communities/${community.id}/channels/${community.channels[0].id}`;

  async function remoteMember(community: Community, domain = "alice.test") {
    const peer = await registerTestPeer(domain);
    const protocolId = newProtocolId();
    const res = await signedPost(peer, `/federation/v1/communities/${community.id}/members`, {
      protocolId,
      username: "alice",
      displayName: "Alice",
    });
    expect(res.status).toBe(201);
    return { peer, protocolId };
  }

  it("lets a remote member delete someone else's message only with DELETE_MESSAGES", async () => {
    const owner = await registerUser("owner");
    const community = await createCommunity(owner);
    const alice = await remoteMember(community);
    const message = await postMessage(owner, community, "from the owner");

    const refused = await signedPost(alice.peer, `${base(community)}/messages/${message}/delete`, { username: "alice" });
    expect(refused.status).toBe(403);
    expect(await isDeleted(message)).toBe(false);

    await grant(owner, community, alice.protocolId, Permission.DELETE_MESSAGES);
    const allowed = await signedPost(alice.peer, `${base(community)}/messages/${message}/delete`, { username: "alice" });
    expect(allowed.status).toBe(204);
    expect(await isDeleted(message)).toBe(true);
  });

  it("never lets a permission held in one community act on a message in another, whatever ids the URL mixes", async () => {
    const owner = await registerUser("owner");
    const a = await createCommunity(owner, "A");
    const b = await createCommunity(owner, "B");
    const alice = await remoteMember(a);
    await grant(owner, a, alice.protocolId, Permission.DELETE_MESSAGES); // moderator of A only
    const inB = await postMessage(owner, b, "belongs to B");

    // A's community and channel in the URL, B's message id: the message is not in A, so it is not found.
    const delRes = await signedPost(alice.peer, `${base(a)}/messages/${inB}/delete`, { username: "alice" });
    expect(delRes.status).toBe(404);
    expect(await isDeleted(inB)).toBe(false);

    // Same for reactions: alice may react in A, which used to be enough to react in B.
    const reactRes = await signedPost(alice.peer, `${base(a)}/messages/${inB}/reactions`, { username: "alice", emoji: "👍" });
    expect(reactRes.status).toBe(404);
    expect(await prisma.reaction.count()).toBe(0);
  });

  it("refuses a remote member's reaction once their role lacks REACT", async () => {
    const owner = await registerUser("owner");
    const community = await createCommunity(owner);
    const alice = await remoteMember(community);
    const message = await postMessage(owner, community);

    const ok = await signedPost(alice.peer, `${base(community)}/messages/${message}/reactions`, { username: "alice", emoji: "👍" });
    expect(ok.status).toBe(200);

    const everyone = community.roles.find((r) => r.isDefault)!;
    await api
      .patch(`/api/v1/communities/${community.id}/roles/${everyone.id}`)
      .set(authHeader(owner.accessToken))
      .send({ name: everyone.name, permissions: perms(Permission.SEND_MESSAGES) });

    const blocked = await signedPost(alice.peer, `${base(community)}/messages/${message}/reactions`, { username: "alice", emoji: "🎉" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("forbidden");
  });
});
