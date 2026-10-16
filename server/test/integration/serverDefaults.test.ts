// A server's defaults and limits for the choices its people and communities make (#189): what a new account or community starts with
// (FEDERATION_CONTACT_POLICY_DEFAULT, COMMUNITY_VISIBILITY_DEFAULT, DIRECTORY_PEOPLE=default-on) and the most any may be (a LIMIT:
// FEDERATION_CONTACT_POLICY_LIMIT, COMMUNITY_VISIBILITY_LIMIT, DIRECTORY_PEOPLE=forced-off). A limit only narrows what someone chose,
// never widens it, and lifting it brings the choice back.
//
// The settings are read at the moment of each decision, so these tests set them per test and put them back.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import type { ContactPolicy } from "../../src/lib/contactPolicy.js";
import type { CommunityVisibility } from "../../src/lib/communityVisibility.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedGet, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);
afterEach(() => {
  config.contactPolicyDefault = "ANYONE";
  config.contactPolicyLimit = "ANYONE";
  config.communityVisibilityDefault = "UNLISTED";
  config.communityVisibilityLimit = "PUBLIC";
  config.directoryPeople = "default-off";
  config.directoryEnabled = false;
});

type Registered = Awaited<ReturnType<typeof registerUser>>;
const FAR = "far.test";
const row = (username: string) => prisma.user.findFirstOrThrow({ where: { username, isRemote: false } });
const patchMe = (who: Registered, body: object) => api.patch("/api/v1/users/me").set(authHeader(who.accessToken)).send(body);
const me = (who: Registered) => api.get("/api/v1/users/me").set(authHeader(who.accessToken));
const stub = (username = "stranger", protocolId = "stranger-protocol-id") =>
  prisma.user.create({ data: { protocolId, username, displayName: username, homeserverDomain: FAR, isRemote: true } });

describe("who may contact a person: the default", () => {
  it("is what new accounts start with, and each can change it", async () => {
    config.contactPolicyDefault = "SHARED_COMMUNITY";

    const alice = await registerUser("alice");

    expect((await row("alice")).contactPolicy).toBe("SHARED_COMMUNITY");
    expect(alice.user).toMatchObject({ contactPolicy: "SHARED_COMMUNITY" });
    expect((await patchMe(alice, { contactPolicy: "ANYONE" })).body.user.contactPolicy).toBe("ANYONE");
  });

  it("leaves accounts that already exist alone", async () => {
    await registerUser("alice");
    config.contactPolicyDefault = "LOCAL_ONLY";

    expect((await row("alice")).contactPolicy).toBe("ANYONE");
  });

  it("is ANYONE when the operator says nothing, as it always was", async () => {
    expect((await registerUser("alice")).user).toMatchObject({ contactPolicy: "ANYONE" });
  });
});

describe("who may contact a person: the limit", () => {
  const friendRequestFrom = (far: Awaited<ReturnType<typeof registerTestPeer>>, to: string) =>
    signedPost(far, "/federation/v1/friend-requests", {
      requestId: newProtocolId(),
      fromProtocolId: "stranger-protocol-id",
      fromUsername: "stranger",
      fromDisplayName: "Stranger",
      toUsername: to,
    });

  it("holds everyone to it, whatever they chose: a server that only lets its own people start things turns another's away", async () => {
    await registerUser("bob"); // chose ANYONE
    const far = await registerTestPeer(FAR);
    config.contactPolicyLimit = "LOCAL_ONLY";

    const res = await friendRequestFrom(far, "bob");
    const verdict = await signedGet(far, "/federation/v1/users/bob?from=stranger");

    expect(res.status).toBe(201); // answered as for any request: it is declined, not shown
    expect(await prisma.friendRequest.count()).toBe(0);
    expect(verdict.body.contact).toEqual({ allowed: false });
  });

  it("still lets people on this server in, and friends", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    config.contactPolicyLimit = "LOCAL_ONLY";

    expect((await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "bob" })).status).toBe(201);

    const far = await registerTestPeer(FAR);
    const friend = await stub();
    const bobRow = await row("bob");
    await prisma.friendship.createMany({ data: [{ userId: bobRow.id, friendId: friend.id }, { userId: friend.id, friendId: bobRow.id }] });
    expect((await signedGet(far, "/federation/v1/users/bob?from=stranger")).body.contact).toEqual({ allowed: true });
  });

  it("applies to people on this server too when it asks for a shared community", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    config.contactPolicyLimit = "SHARED_COMMUNITY";

    const refused = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "bob" });
    await prisma.community.create({
      data: {
        protocolId: newProtocolId(),
        name: "Club",
        ownerId: (await row("alice")).id,
        homeserverDomain: config.domain,
        members: { create: [{ userId: (await row("alice")).id }, { userId: (await row("bob")).id }] },
      },
    });
    const allowed = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "bob" });

    expect([refused.status, refused.body.error]).toEqual([403, "contact_not_allowed"]);
    expect(allowed.status).toBe(201);
  });

  it("can be narrowed further by the person, but never widened: both must allow", async () => {
    const bob = await registerUser("bob");
    await prisma.user.create({ data: { protocolId: newProtocolId(), username: "carl", displayName: "Carl", homeserverDomain: config.domain } });
    const alice = await registerUser("alice");
    config.contactPolicyLimit = "LOCAL_ONLY";
    await patchMe(bob, { contactPolicy: "SHARED_COMMUNITY" }); // narrower on another axis

    const local = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "bob" });

    expect([local.status, local.body.error]).toEqual([403, "contact_not_allowed"]); // the server lets locals in, bob wants a shared community
  });

  it("shows the person the limit, so Settings can say it applies", async () => {
    const alice = await registerUser("alice");
    config.contactPolicyLimit = "LOCAL_ONLY";

    expect((await me(alice)).body.user).toMatchObject({ contactPolicy: "ANYONE", contactPolicyLimit: "LOCAL_ONLY" });
    expect((await patchMe(alice, { bio: "x" })).body.user.contactPolicyLimit).toBe("LOCAL_ONLY");
  });

  it("goes away when it is lifted: the person's own choice applies again", async () => {
    await registerUser("bob");
    const far = await registerTestPeer(FAR);
    config.contactPolicyLimit = "LOCAL_ONLY";
    expect((await signedGet(far, "/federation/v1/users/bob?from=stranger")).body.contact.allowed).toBe(false);

    config.contactPolicyLimit = "ANYONE";

    expect((await signedGet(far, "/federation/v1/users/bob?from=stranger")).body.contact.allowed).toBe(true);
  });
});

describe("a new community's visibility: the default", () => {
  const create = (who: Registered) => api.post("/api/v1/communities").set(authHeader(who.accessToken)).send({ name: "Book Club" });

  it("is unlisted unless the operator chose, as every community always started", async () => {
    const alice = await registerUser("alice");

    expect((await create(alice)).body.community).toMatchObject({ visibility: "UNLISTED", openJoin: true, visibilityLimit: "PUBLIC" });
  });

  it("is what the operator chose for new communities, and a manager can still change it", async () => {
    const alice = await registerUser("alice");
    config.communityVisibilityDefault = "INVITE_ONLY";

    const made = await create(alice);
    expect(made.body.community).toMatchObject({ visibility: "INVITE_ONLY", openJoin: false });

    const changed = await api.patch(`/api/v1/communities/${made.body.community.id}`).set(authHeader(alice.accessToken)).send({ visibility: "UNLISTED" });
    expect(changed.body.community.visibility).toBe("UNLISTED");
  });

  it("leaves communities that already exist alone", async () => {
    const alice = await registerUser("alice");
    const made = await create(alice);
    config.communityVisibilityDefault = "LOCAL_ONLY";

    expect((await prisma.community.findUniqueOrThrow({ where: { protocolId: made.body.community.id } })).visibility).toBe("UNLISTED");
  });
});

describe("a community's visibility: the limit", () => {
  async function community(owner: Registered, visibility: CommunityVisibility) {
    const ownerRow = await row(owner.user.username);
    return prisma.community.create({
      data: { protocolId: newProtocolId(), name: "Book Club", ownerId: ownerRow.id, homeserverDomain: config.domain, visibility, members: { create: [{ userId: ownerRow.id }] } },
    });
  }
  const patch = (who: Registered, id: string, body: object) => api.patch(`/api/v1/communities/${id}`).set(authHeader(who.accessToken)).send(body);
  const remoteJoin = (far: Awaited<ReturnType<typeof registerTestPeer>>, id: string) =>
    signedPost(far, `/federation/v1/communities/${id}/members`, { protocolId: "stranger-protocol-id", username: "stranger" });

  it("refuses a choice that is wider than it, saying what the limit is, and accepts any that is not", async () => {
    const alice = await registerUser("alice");
    const made = await community(alice, "UNLISTED");
    config.communityVisibilityLimit = "UNLISTED";

    const wider = await patch(alice, made.protocolId, { visibility: "PUBLIC" });
    const same = await patch(alice, made.protocolId, { visibility: "UNLISTED" });
    const narrower = await patch(alice, made.protocolId, { visibility: "INVITE_ONLY" });

    expect([wider.status, wider.body]).toEqual([409, { error: "visibility_limited", limit: "UNLISTED" }]);
    expect(same.status).toBe(200);
    expect(narrower.body.community.visibility).toBe("INVITE_ONLY");
  });

  it("holds a community that was already wider to the limit: it behaves as the limit, and says so", async () => {
    const alice = await registerUser("alice");
    const made = await community(alice, "PUBLIC");
    config.communityVisibilityLimit = "UNLISTED";

    const list = await api.get("/api/v1/communities").set(authHeader(alice.accessToken));

    expect(list.body.communities[0]).toMatchObject({ visibility: "UNLISTED", visibilityLimit: "UNLISTED", openJoin: true });
    expect((await prisma.community.findUniqueOrThrow({ where: { id: made.id } })).visibility).toBe("PUBLIC"); // what was chosen is kept
  });

  it("brings the choice back when the limit is lifted", async () => {
    const alice = await registerUser("alice");
    await community(alice, "PUBLIC");
    config.communityVisibilityLimit = "INVITE_ONLY";
    expect((await api.get("/api/v1/communities").set(authHeader(alice.accessToken))).body.communities[0].visibility).toBe("INVITE_ONLY");

    config.communityVisibilityLimit = "PUBLIC";

    expect((await api.get("/api/v1/communities").set(authHeader(alice.accessToken))).body.communities[0].visibility).toBe("PUBLIC");
  });

  it("lists no public communities where public is not allowed, whatever they were set to", async () => {
    config.directoryEnabled = true;
    const alice = await registerUser("alice");
    await community(alice, "PUBLIC");
    expect((await api.get("/api/v1/directory/communities").set(authHeader(alice.accessToken))).body.items).toHaveLength(1);

    config.communityVisibilityLimit = "UNLISTED";

    expect((await api.get("/api/v1/directory/communities").set(authHeader(alice.accessToken))).body.items).toEqual([]);
  });

  it("makes everything need an invite when the limit is invite-only, from this server and from another", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const made = await community(alice, "UNLISTED");
    config.communityVisibilityLimit = "INVITE_ONLY";
    const far = await registerTestPeer(FAR);

    const local = await api.post(`/api/v1/communities/${made.protocolId}/members`).set(authHeader(bob.accessToken)).send({});
    const remote = await remoteJoin(far, made.protocolId);

    expect([local.status, local.body.error]).toEqual([403, "invite_required"]);
    expect([remote.status, remote.body.error]).toEqual([403, "invite_required"]);
  });

  it("keeps other servers out entirely when the limit is local-only: a join is told the community does not exist, and so is a snapshot", async () => {
    const alice = await registerUser("alice");
    const made = await community(alice, "UNLISTED");
    config.communityVisibilityLimit = "LOCAL_ONLY";
    const far = await registerTestPeer(FAR);

    const join = await remoteJoin(far, made.protocolId);
    const snapshot = await signedGet(far, `/federation/v1/communities/${made.protocolId}`);

    expect([join.status, join.body.error]).toEqual([404, "not_found"]);
    expect([snapshot.status, snapshot.body.error]).toEqual([404, "not_found"]);
    expect(await prisma.communityMember.count({ where: { user: { isRemote: true } } })).toBe(0);
  });

  it("tells other servers what is in force, not what was chosen", async () => {
    const alice = await registerUser("alice");
    const made = await community(alice, "PUBLIC");
    const far = await registerTestPeer(FAR);
    expect((await remoteJoin(far, made.protocolId)).status).toBe(201);
    config.communityVisibilityLimit = "UNLISTED";

    const snapshot = await signedGet(far, `/federation/v1/communities/${made.protocolId}`);

    expect(snapshot.body.community).toMatchObject({ visibility: "UNLISTED", openJoin: true });
  });

  it("holds a client that still sends the old yes/no to the limit too", async () => {
    const alice = await registerUser("alice");
    const made = await community(alice, "INVITE_ONLY");
    config.communityVisibilityLimit = "INVITE_ONLY";

    const res = await patch(alice, made.protocolId, { openJoin: true }); // would reopen it to anyone with the id

    expect(res.status).toBe(200);
    expect((await prisma.community.findUniqueOrThrow({ where: { id: made.id } })).visibility).toBe("INVITE_ONLY");
  });

  it("will not send a card to a friend on another server for a community the limit keeps local", async () => {
    const alice = await registerUser("alice");
    const made = await community(alice, "UNLISTED");
    const rex = await stub("rex", "rex-protocol-id");
    const aliceRow = await row("alice");
    const conversation = await prisma.conversation.create({
      data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: aliceRow.id }, { userId: rex.id }] } },
    });
    config.communityVisibilityLimit = "LOCAL_ONLY";

    const res = await api
      .post(`/api/v1/conversations/${conversation.protocolId}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ invite: { communityId: made.protocolId } });

    expect([res.status, res.body.error]).toEqual([403, "community_local_only"]);
  });

  it("will not make an invite for a member on another server of a community the limit keeps local", async () => {
    const alice = await registerUser("alice");
    const made = await community(alice, "UNLISTED");
    const far = await registerTestPeer(FAR);
    expect((await remoteJoin(far, made.protocolId)).status).toBe(201); // before the limit
    config.communityVisibilityLimit = "LOCAL_ONLY";

    const res = await signedPost(far, `/federation/v1/communities/${made.protocolId}/invites`, { username: "stranger" });

    expect([res.status, res.body.error]).toEqual([403, "community_local_only"]);
    expect(await prisma.invite.count()).toBe(0);
  });

  it("leaves a community that is narrower than the limit alone", async () => {
    const alice = await registerUser("alice");
    await community(alice, "LOCAL_ONLY");
    config.communityVisibilityLimit = "UNLISTED";

    expect((await api.get("/api/v1/communities").set(authHeader(alice.accessToken))).body.communities[0].visibility).toBe("LOCAL_ONLY");
  });
});

describe("people in the directory: the mode", () => {
  const people = (who: Registered) => api.get("/api/v1/directory/people").set(authHeader(who.accessToken));

  it("starts new accounts unlisted by default, and listed under default-on, who can then opt out", async () => {
    config.directoryEnabled = true;
    const first = await registerUser("first");
    config.directoryPeople = "default-on";
    const second = await registerUser("second");
    const viewer = await registerUser("viewer");

    expect(first.user).toMatchObject({ listedInDirectory: false });
    expect(second.user).toMatchObject({ listedInDirectory: true });
    expect((await people(viewer)).body.items.map((p: { username: string }) => p.username)).toEqual(["second"]);

    await patchMe(second, { listedInDirectory: false });
    expect((await people(viewer)).body.items).toEqual([]);
  });

  it("still never lists someone who is hidden from other servers, however they started", async () => {
    config.directoryEnabled = true;
    config.directoryPeople = "default-on";
    const hidden = await registerUser("hidy");
    const viewer = await registerUser("viewer");
    await patchMe(hidden, { discoverable: false });

    expect((await people(viewer)).body.items.map((p: { username: string }) => p.username)).toEqual([]); // not them, and not the viewer, who is left out of their own view
  });

  it("lists nobody under forced-off, whatever they chose, and says so to the person, who cannot change it", async () => {
    config.directoryEnabled = true;
    const chosen = await registerUser("chosen");
    await patchMe(chosen, { listedInDirectory: true });
    const viewer = await registerUser("viewer");
    expect((await people(viewer)).body.items).toHaveLength(1);

    config.directoryPeople = "forced-off";
    const change = await patchMe(chosen, { listedInDirectory: false });

    expect((await people(viewer)).body.items).toEqual([]);
    expect([change.status, change.body.error]).toEqual([409, "directory_listing_locked"]);
    expect((await me(chosen)).body.user).toMatchObject({ directoryPeopleLocked: true });
  });

  it("does not stop the rest of a profile update under forced-off, only the choice to be listed", async () => {
    config.directoryPeople = "forced-off";
    const alice = await registerUser("alice");

    expect((await patchMe(alice, { bio: "hello" })).status).toBe(200);
  });

  it("starts unlocked, and listing not locked, when the operator says nothing", async () => {
    const alice = await registerUser("alice");

    expect((await me(alice)).body.user).toMatchObject({ directoryPeopleLocked: false, listedInDirectory: false });
  });

  it("can be listed again when the lock is lifted: the person's own choice comes back", async () => {
    config.directoryEnabled = true;
    const chosen = await registerUser("chosen");
    await patchMe(chosen, { listedInDirectory: true });
    const viewer = await registerUser("viewer");
    config.directoryPeople = "forced-off";
    expect((await people(viewer)).body.items).toEqual([]);

    config.directoryPeople = "default-off";

    expect((await people(viewer)).body.items).toHaveLength(1);
  });
});
