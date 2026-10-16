// Who may join a community (#109, phase 4): UNLISTED (anyone with the id, as every community was), INVITE_ONLY (an invite is
// needed) or LOCAL_ONLY (only accounts on the community's own server; anyone else is told it does not exist). Decided in one
// place, on the community's home server, for a local join and a federated one alike.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { applyCommunitySnapshot } from "../../src/modules/federation/communitySnapshot.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { registerTestPeer, signedGet, signedPost } from "../helpers/federation.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
type Visibility = "UNLISTED" | "INVITE_ONLY" | "LOCAL_ONLY";
const FAR = "far.test";

async function createCommunity(owner: Registered, visibility?: Visibility) {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name: "Book Club" });
  expect(res.status).toBe(201);
  const community = res.body.community as { id: string; visibility: Visibility; openJoin: boolean };
  if (visibility && visibility !== "UNLISTED") await patch(owner, community, { visibility });
  return community;
}

const patch = (who: Registered, community: { id: string }, body: object) =>
  api.patch(`/api/v1/communities/${community.id}`).set(authHeader(who.accessToken)).send(body);
const join = (who: Registered, ref: string, body: object = {}) =>
  api.post(`/api/v1/communities/${encodeURIComponent(ref)}/members`).set(authHeader(who.accessToken)).send(body);
const stored = async (community: { id: string }) => (await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } })).visibility;

/** What someone on another server sends to join: their server asks the community's home server. */
const remoteJoin = (far: Awaited<ReturnType<typeof registerTestPeer>>, communityId: string, over: { username?: string; inviteCode?: string } = {}) =>
  signedPost(far, `/federation/v1/communities/${communityId}/members`, {
    protocolId: over.username ? `${over.username}-protocol-id` : "stranger-protocol-id",
    username: over.username ?? "stranger",
    inviteCode: over.inviteCode,
  });

const remoteStub = (username = "stranger") =>
  prisma.user.create({ data: { protocolId: `${username}-protocol-id`, username, displayName: username, homeserverDomain: FAR, isRemote: true } });

describe("the setting", () => {
  it("starts as UNLISTED, which is what every community was, and is shown with the old yes/no derived from it", async () => {
    const alice = await registerUser("alice");

    const community = await createCommunity(alice);

    expect(community).toMatchObject({ visibility: "UNLISTED", openJoin: true });
  });

  it("is changed by someone who manages the community, to any of the three, and the old yes/no follows", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);

    for (const [visibility, openJoin] of [["INVITE_ONLY", false], ["LOCAL_ONLY", true], ["UNLISTED", true]] as const) {
      const res = await patch(alice, community, { visibility });
      expect([res.status, res.body.community.visibility, res.body.community.openJoin]).toEqual([200, visibility, openJoin]);
      expect(await stored(community)).toBe(visibility);
    }
  });

  it("is not changed by an ordinary member, and refuses anything but the three names", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(bob, community.id);

    expect((await patch(bob, community, { visibility: "LOCAL_ONLY" })).status).toBe(403);
    for (const value of ["PUBLIC", "local_only", "", null, true]) {
      expect([(await patch(alice, community, { visibility: value })).status, value]).toEqual([400, value]);
    }
    expect(await stored(community)).toBe("UNLISTED");
  });

  describe("for a client that still sends the old yes/no", () => {
    it("closes to invite-only on false, and reopens an invite-only community on true", async () => {
      const alice = await registerUser("alice");
      const community = await createCommunity(alice);

      await patch(alice, community, { openJoin: false });
      expect(await stored(community)).toBe("INVITE_ONLY");
      await patch(alice, community, { openJoin: true });
      expect(await stored(community)).toBe("UNLISTED");
    });

    it("leaves a local-only community local-only on true, since it is already open to everyone it accepts", async () => {
      const alice = await registerUser("alice");
      const community = await createCommunity(alice, "LOCAL_ONLY");

      await patch(alice, community, { openJoin: true });

      expect(await stored(community)).toBe("LOCAL_ONLY");
    });

    it("lets visibility win when both are sent", async () => {
      const alice = await registerUser("alice");
      const community = await createCommunity(alice);

      await patch(alice, community, { visibility: "LOCAL_ONLY", openJoin: false });

      expect(await stored(community)).toBe("LOCAL_ONLY");
    });
  });
});

describe("joining from this server", () => {
  it("is by the id under UNLISTED and LOCAL_ONLY, and needs an invite under INVITE_ONLY", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const dave = await registerUser("dave");
    const open = await createCommunity(alice);
    const local = await createCommunity(alice, "LOCAL_ONLY");
    const closed = await createCommunity(alice, "INVITE_ONLY");

    expect((await join(bob, open.id)).status).toBe(201);
    expect((await join(carol, local.id)).status).toBe(201);
    const refused = await join(dave, closed.id);
    expect([refused.status, refused.body.error]).toEqual([403, "invite_required"]);
  });

  it("accepts an invite for a local-only community as for any other", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice, "LOCAL_ONLY");
    const invite = await api.post(`/api/v1/communities/${community.id}/invites`).set(authHeader(alice.accessToken)).send({});

    expect((await join(bob, community.id, { inviteCode: invite.body.invite.code })).status).toBe(201);
  });
});

describe("joining from another server", () => {
  it("works under UNLISTED, as it always has", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const far = await registerTestPeer(FAR);

    expect((await remoteJoin(far, community.id)).status).toBe(201);
  });

  it("is refused under LOCAL_ONLY as if the community did not exist: the same status and body as for an id nobody has", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice, "LOCAL_ONLY");
    const far = await registerTestPeer(FAR);

    const local = await remoteJoin(far, community.id);
    const missing = await remoteJoin(far, "NOSUCHCOMMUNITY");

    expect([local.status, local.body]).toEqual([404, { error: "not_found" }]);
    expect([local.status, local.body]).toEqual([missing.status, missing.body]);
    expect(await prisma.communityMember.count({ where: { user: { isRemote: true } } })).toBe(0);
  });

  it("is refused even with a perfectly good invite", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice, "LOCAL_ONLY");
    const invite = await api.post(`/api/v1/communities/${community.id}/invites`).set(authHeader(alice.accessToken)).send({});
    const far = await registerTestPeer(FAR);

    const res = await remoteJoin(far, community.id, { inviteCode: invite.body.invite.code });

    expect([res.status, res.body.error]).toEqual([404, "not_found"]);
    expect((await prisma.invite.findUniqueOrThrow({ where: { code: invite.body.invite.code } })).uses).toBe(0); // and none was spent
  });

  it("does not reveal a ban either: someone banned who is on another server is told it does not exist", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice, "LOCAL_ONLY");
    const far = await registerTestPeer(FAR);
    const stranger = await remoteStub();
    await prisma.communityBan.create({ data: { communityId: (await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } })).id, userId: stranger.id } });

    const res = await remoteJoin(far, community.id);

    expect([res.status, res.body.error]).toEqual([404, "not_found"]);
  });

  it("leaves someone from another server who was already in alone when it is switched to local-only", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const far = await registerTestPeer(FAR);
    expect((await remoteJoin(far, community.id)).status).toBe(201);

    await patch(alice, community, { visibility: "LOCAL_ONLY" });

    expect((await remoteJoin(far, community.id)).status).toBe(201); // already a member: fine
    expect(await prisma.communityMember.count({ where: { user: { isRemote: true } } })).toBe(1);
  });

  it("is refused under INVITE_ONLY without an invite, and works with one, as before", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice, "INVITE_ONLY");
    const far = await registerTestPeer(FAR);
    const invite = await api.post(`/api/v1/communities/${community.id}/invites`).set(authHeader(alice.accessToken)).send({});

    expect((await remoteJoin(far, community.id)).body.error).toBe("invite_required");
    expect((await remoteJoin(far, community.id, { inviteCode: invite.body.invite.code })).status).toBe(201);
  });
});

describe("what another server may learn about a community", () => {
  const snapshot = (far: Awaited<ReturnType<typeof registerTestPeer>>, id: string) => signedGet(far, `/federation/v1/communities/${id}`);
  const membership = (far: Awaited<ReturnType<typeof registerTestPeer>>, id: string) =>
    signedGet(far, `/federation/v1/communities/${id}/membership?username=stranger&domain=${FAR}`);

  it("is, for a server with no member in it, 'you have no member here' - unless it is local-only, when it is 'not found'", async () => {
    const alice = await registerUser("alice");
    const open = await createCommunity(alice);
    const local = await createCommunity(alice, "LOCAL_ONLY");
    const far = await registerTestPeer(FAR);

    for (const ask of [snapshot, membership]) {
      expect([(await ask(far, open.id)).status, (await ask(far, open.id)).body.error]).toEqual([403, "not_a_member_domain"]);
      const hidden = await ask(far, local.id);
      const missing = await ask(far, "NOSUCHCOMMUNITY");
      expect([hidden.status, hidden.body]).toEqual([404, { error: "not_found" }]);
      expect([hidden.status, hidden.body]).toEqual([missing.status, missing.body]);
    }
  });

  it("still goes to a server that already has a member, after the community is made local-only", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const far = await registerTestPeer(FAR);
    await remoteJoin(far, community.id);
    await patch(alice, community, { visibility: "LOCAL_ONLY" });

    const res = await snapshot(far, community.id);

    expect(res.status).toBe(200);
    expect(res.body.community).toMatchObject({ visibility: "LOCAL_ONLY", openJoin: true });
  });

  it("carries the visibility, and the old yes/no derived from it for a server that reads only that", async () => {
    const alice = await registerUser("alice");
    const closed = await createCommunity(alice, "INVITE_ONLY");
    const far = await registerTestPeer(FAR);
    await remoteJoin(far, closed.id, { inviteCode: (await api.post(`/api/v1/communities/${closed.id}/invites`).set(authHeader(alice.accessToken)).send({})).body.invite.code });

    const res = await snapshot(far, closed.id);

    expect(res.body.community).toMatchObject({ visibility: "INVITE_ONLY", openJoin: false });
  });
});

describe("a community on another server, as this server holds it", () => {
  const apply = async (extra: object) => {
    await registerTestPeer(FAR); // so the owner can be recorded without going to look the server up
    const owner = { protocolId: "olga-protocol-id", username: "olga", domain: FAR, displayName: "Olga", avatarUrl: null };
    await applyCommunitySnapshot(
      { protocolId: "far-community", name: "Far Club", description: null, iconUrl: null, owner, channels: [], ...extra } as never,
      FAR
    );
    return (await prisma.community.findUniqueOrThrow({ where: { protocolId: "far-community" } })).visibility;
  };

  it("takes the visibility the home server says", async () => {
    expect(await apply({ visibility: "LOCAL_ONLY", openJoin: true })).toBe("LOCAL_ONLY");
  });

  it("works it out from the old yes/no when the home server predates visibility", async () => {
    expect(await apply({ openJoin: false })).toBe("INVITE_ONLY");
    expect(await apply({ openJoin: true })).toBe("UNLISTED");
  });

  it("treats a server that says nothing about either as open, and ignores a name it does not know", async () => {
    expect(await apply({})).toBe("UNLISTED");
    expect(await apply({ visibility: "PUBLIC", openJoin: false })).toBe("INVITE_ONLY"); // PUBLIC is not one we know: the yes/no decides
    expect(await apply({ visibility: { $gt: "" } })).toBe("UNLISTED");
  });
});

describe("an invitation card for a friend", () => {
  async function friendOnAnotherServer(alice: Registered) {
    const rex = await remoteStub("rex");
    const aliceRow = await prisma.user.findFirstOrThrow({ where: { username: "alice", isRemote: false } });
    const conversation = await prisma.conversation.create({
      data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: aliceRow.id }, { userId: rex.id }] } },
    });
    expect(alice).toBeTruthy();
    return conversation.protocolId;
  }
  const sendCard = (from: Registered, conversationId: string, community: { id: string }) =>
    api.post(`/api/v1/conversations/${conversationId}/messages`).set(authHeader(from.accessToken)).send({ invite: { communityId: community.id } });

  it("cannot be sent to someone on another server for a local-only community, since they could not join", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice, "LOCAL_ONLY");
    const conversation = await friendOnAnotherServer(alice);

    const res = await sendCard(alice, conversation, community);

    expect([res.status, res.body.error]).toEqual([403, "community_local_only"]);
    expect(await prisma.message.count()).toBe(0);
  });

  it("can be sent to someone on this server, and to someone on another server for any other kind", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const local = await createCommunity(alice, "LOCAL_ONLY");
    const open = await createCommunity(alice);
    const withBob = (await api.post("/api/v1/conversations").set(authHeader(alice.accessToken)).send({ type: "DM", memberUsernames: ["bob"] })).body.conversation.id;
    const withRex = await friendOnAnotherServer(alice);

    expect((await sendCard(alice, withBob, local)).status).toBe(201);
    expect((await sendCard(alice, withRex, open)).status).toBe(201);
    expect(bob).toBeTruthy();
  });

  it("is not made on request by a member from another server of a local-only community", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const far = await registerTestPeer(FAR);
    await remoteJoin(far, community.id);
    await patch(alice, community, { visibility: "LOCAL_ONLY" });

    const res = await signedPost(far, `/federation/v1/communities/${community.id}/invites`, { username: "stranger" });

    expect([res.status, res.body.error]).toEqual([403, "community_local_only"]);
    expect(await prisma.invite.count()).toBe(0);
  });
});

describe("what this server's own people see", () => {
  it("includes the visibility of each community they are in", async () => {
    const alice = await registerUser("alice");
    await createCommunity(alice, "LOCAL_ONLY");

    const res = await api.get("/api/v1/communities").set(authHeader(alice.accessToken));

    expect(res.body.communities[0]).toMatchObject({ visibility: "LOCAL_ONLY", openJoin: true, homeserverDomain: config.domain });
  });
});
