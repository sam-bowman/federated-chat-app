// Who can find a person (#109, phase 3). A person can hide from servers they have no relationship with: such a server is told
// they do not exist - for a lookup, a friend request and a conversation alike, in a way that cannot be told from a person who
// really does not exist. A server that already has a relationship with them (a friendship, a pending request, a conversation, a
// community in common) keeps working. The server's own setting, FEDERATION_USER_DISCOVERABILITY, can only narrow what people
// choose.
//
// config.userDiscoverability is read at the moment of each decision, so these tests flip it per test and put it back.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedGet, signedPost, type TestPeer } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);
afterEach(() => {
  config.userDiscoverability = "default-on";
  vi.restoreAllMocks();
});

const FAR = "far.test";
const ELSEWHERE = "elsewhere.test";

async function hide(accessToken: string) {
  const res = await api.patch("/api/v1/users/me").set(authHeader(accessToken)).send({ discoverable: false });
  expect(res.status).toBe(200);
}

const localRow = (username: string) => prisma.user.findFirstOrThrow({ where: { username, isRemote: false } });

/** A person on another server, as this server would know them once something has happened with them. */
const remoteStub = (domain: string, username = "rex") =>
  prisma.user.create({ data: { protocolId: newProtocolId(), username, displayName: username, homeserverDomain: domain, isRemote: true } });

/** What a server with no relationship does: look the person up, ask to be their friend, put them in a conversation. */
const lookup = (peer: TestPeer, username: string) => signedGet(peer, `/federation/v1/users/${username}`);
const friendRequest = (peer: TestPeer, toUsername: string) =>
  signedPost(peer, "/federation/v1/friend-requests", {
    requestId: newProtocolId(),
    fromProtocolId: newProtocolId(),
    fromUsername: "stranger",
    fromDisplayName: "Stranger",
    toUsername,
  });
const conversationWith = (peer: TestPeer, localUsername: string, type: "DM" | "GROUP" = "DM") =>
  signedPost(peer, "/federation/v1/conversations", {
    conversationId: newProtocolId(),
    type,
    members: [
      { username: localUsername, domain: config.domain, protocolId: newProtocolId() },
      { username: "stranger", domain: peer.domain, protocolId: newProtocolId(), displayName: "Stranger" },
    ],
  });

describe("by default", () => {
  it("lets any server look a person up, as ever", async () => {
    await registerUser("hidy");
    const far = await registerTestPeer(FAR);

    const res = await lookup(far, "hidy");

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "hidy" });
  });

  it("starts every account findable", async () => {
    const hidy = await registerUser("hidy");

    expect((await localRow("hidy")).discoverable).toBe(true);
    expect(hidy.user).toMatchObject({ discoverable: true });
  });
});

describe("a person who has hidden", () => {
  it("is not found by a server with no relationship to them: the same answer as for someone who does not exist", async () => {
    const hidy = await registerUser("hidy");
    await hide(hidy.accessToken);
    const far = await registerTestPeer(FAR);

    const hidden = await lookup(far, "hidy");
    const missing = await lookup(far, "nobody_here");

    expect([hidden.status, hidden.body]).toEqual([404, { error: "not_found" }]);
    expect([hidden.status, hidden.body]).toEqual([missing.status, missing.body]);
    expect(hidden.headers["content-type"]).toBe(missing.headers["content-type"]);
    expect(hidden.headers["content-length"]).toBe(missing.headers["content-length"]);
  });

  // The same work is done for both, so a hidden person cannot be told from a missing one by how long the answer takes either.
  it("costs the same to look up as someone who does not exist, and a findable person skips that work", async () => {
    const hidy = await registerUser("hidy");
    await registerUser("open");
    await hide(hidy.accessToken);
    const far = await registerTestPeer(FAR);
    const relationshipQueries = vi.spyOn(prisma.friendship, "findFirst");

    await lookup(far, "hidy");
    const forHidden = relationshipQueries.mock.calls.length;
    await lookup(far, "nobody_here");
    const forMissing = relationshipQueries.mock.calls.length - forHidden;
    await lookup(far, "open");
    const forFindable = relationshipQueries.mock.calls.length - forHidden - forMissing;

    expect([forHidden, forMissing]).toEqual([1, 1]);
    expect(forFindable).toBe(0);
  });

  it("cannot be sent a friend request by such a server, which is told they do not exist, and nothing is stored", async () => {
    const hidy = await registerUser("hidy");
    await hide(hidy.accessToken);
    const far = await registerTestPeer(FAR);

    const hidden = await friendRequest(far, "hidy");
    const missing = await friendRequest(far, "nobody_here");

    expect([hidden.status, hidden.body]).toEqual([404, { error: "user_not_found" }]);
    expect([hidden.status, hidden.body]).toEqual([missing.status, missing.body]);
    expect(await prisma.friendRequest.count()).toBe(0);
    expect(await prisma.user.count({ where: { isRemote: true } })).toBe(0); // the stranger was not even recorded
  });

  it("cannot be put in a conversation by such a server, which is told they do not exist, and nothing is stored", async () => {
    const hidy = await registerUser("hidy");
    await registerUser("other");
    await hide(hidy.accessToken);
    const far = await registerTestPeer(FAR);

    const dm = await conversationWith(far, "hidy");
    const group = await conversationWith(far, "hidy", "GROUP");
    const missing = await conversationWith(far, "nobody_here");

    for (const res of [dm, group]) expect([res.status, res.body]).toEqual([missing.status, missing.body]);
    expect([dm.status, dm.body]).toEqual([404, { error: "user_not_found" }]);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("can be found again as soon as they stop hiding", async () => {
    const hidy = await registerUser("hidy");
    const far = await registerTestPeer(FAR);
    await hide(hidy.accessToken);
    expect((await lookup(far, "hidy")).status).toBe(404);

    await api.patch("/api/v1/users/me").set(authHeader(hidy.accessToken)).send({ discoverable: true });

    expect((await lookup(far, "hidy")).status).toBe(200);
  });

  it("is not hidden from people on their own server", async () => {
    const hidy = await registerUser("hidy");
    const other = await registerUser("other");
    await hide(hidy.accessToken);

    const search = await api.get("/api/v1/users/search?q=hid").set(authHeader(other.accessToken));
    const request = await api.post("/api/v1/friends/requests").set(authHeader(other.accessToken)).send({ username: "hidy" });
    const profile = await api.get(`/api/v1/users/${hidy.user.id}/profile`).set(authHeader(other.accessToken));

    expect(search.body.users.map((u: { username: string }) => u.username)).toContain("hidy");
    expect(request.status).toBe(201);
    expect(profile.status).toBe(200);
  });
});

// A server that already has something with the person already knows them: it is not told anything new, and what they have
// together must keep working when the person hides.
describe("a server that already has a relationship with someone who has hidden", () => {
  type Setup = (hidyId: string, rex: { id: string }) => Promise<void>;
  const relationships: [string, Setup][] = [
    [
      "a friendship",
      async (hidyId, rex) => {
        await prisma.friendship.createMany({
          data: [
            { userId: hidyId, friendId: rex.id },
            { userId: rex.id, friendId: hidyId },
          ],
        });
      },
    ],
    [
      "a friend request they sent to someone there",
      async (hidyId, rex) => {
        await prisma.friendRequest.create({ data: { protocolId: newProtocolId(), fromUserId: hidyId, toUserId: rex.id } });
      },
    ],
    [
      "a friend request someone there sent them",
      async (hidyId, rex) => {
        await prisma.friendRequest.create({ data: { protocolId: newProtocolId(), fromUserId: rex.id, toUserId: hidyId } });
      },
    ],
    [
      "a conversation with someone there",
      async (hidyId, rex) => {
        await prisma.conversation.create({
          data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: hidyId }, { userId: rex.id }] } },
        });
      },
    ],
    [
      "a community they are both in, hosted here",
      async (hidyId, rex) => {
        await prisma.community.create({
          data: {
            protocolId: newProtocolId(),
            name: "Club",
            ownerId: hidyId,
            homeserverDomain: config.domain,
            members: { create: [{ userId: hidyId }, { userId: rex.id }] },
          },
        });
      },
    ],
    [
      "a community hosted there that they belong to",
      async (hidyId, rex) => {
        await prisma.community.create({
          data: {
            protocolId: newProtocolId(),
            name: "Far Club",
            ownerId: rex.id,
            homeserverDomain: FAR,
            isRemote: true,
            members: { create: [{ userId: hidyId }] },
          },
        });
      },
    ],
  ];

  it.each(relationships)("still finds them, on the strength of %s", async (_name, setup) => {
    const hidy = await registerUser("hidy");
    await hide(hidy.accessToken);
    const far = await registerTestPeer(FAR);
    const rex = await remoteStub(FAR);
    await setup((await localRow("hidy")).id, rex);

    const res = await lookup(far, "hidy");

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "hidy" });
  });

  it("compares the server without regard to case", async () => {
    const hidy = await registerUser("hidy");
    await hide(hidy.accessToken);
    const far = await registerTestPeer(FAR);
    const rex = await remoteStub("Far.Test"); // however the other server's domain was first written down
    await prisma.friendship.createMany({
      data: [
        { userId: (await localRow("hidy")).id, friendId: rex.id },
        { userId: rex.id, friendId: (await localRow("hidy")).id },
      ],
    });

    expect((await lookup(far, "hidy")).status).toBe(200);
  });

  it("is told nothing by the strength of a relationship with a different server", async () => {
    const hidy = await registerUser("hidy");
    await hide(hidy.accessToken);
    const far = await registerTestPeer(FAR);
    const elsewhere = await remoteStub(ELSEWHERE);
    await prisma.friendship.createMany({
      data: [
        { userId: (await localRow("hidy")).id, friendId: elsewhere.id },
        { userId: elsewhere.id, friendId: (await localRow("hidy")).id },
      ],
    });

    expect((await lookup(far, "hidy")).status).toBe(404);
  });

  it("does not count a request that was declined, or a friendship that has ended", async () => {
    const hidy = await registerUser("hidy");
    await hide(hidy.accessToken);
    const far = await registerTestPeer(FAR);
    const rex = await remoteStub(FAR);
    const hidyRow = await localRow("hidy");
    await prisma.friendRequest.create({ data: { protocolId: newProtocolId(), fromUserId: rex.id, toUserId: hidyRow.id, status: "DECLINED" } });

    expect((await lookup(far, "hidy")).status).toBe(404);

    await prisma.friendship.createMany({
      data: [
        { userId: hidyRow.id, friendId: rex.id },
        { userId: rex.id, friendId: hidyRow.id },
      ],
    });
    expect((await lookup(far, "hidy")).status).toBe(200);
    await prisma.friendship.deleteMany({});
    expect((await lookup(far, "hidy")).status).toBe(404);
  });

  it("goes on receiving what that server sends them: hiding does not cut off a conversation", async () => {
    const hidy = await registerUser("hidy");
    await hide(hidy.accessToken);
    const far = await registerTestPeer(FAR);
    const rex = await remoteStub(FAR);
    const conversation = await prisma.conversation.create({
      data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: (await localRow("hidy")).id }, { userId: rex.id }] } },
    });

    const sent = await signedPost(far, "/federation/v1/messages", {
      conversationId: conversation.protocolId,
      messageId: newProtocolId(),
      fromProtocolId: rex.protocolId,
      fromUsername: rex.username,
      fromDomain: FAR,
      content: "still here?",
    });

    expect(sent.status).toBe(201);
    expect(await prisma.message.count()).toBe(1);
  });

  it("can still be sent a friend request by a server that is already their friend's, and a conversation by one that has one", async () => {
    const hidy = await registerUser("hidy");
    await hide(hidy.accessToken);
    const far = await registerTestPeer(FAR);
    const rex = await remoteStub(FAR);
    await prisma.community.create({
      data: {
        protocolId: newProtocolId(),
        name: "Club",
        ownerId: (await localRow("hidy")).id,
        homeserverDomain: config.domain,
        members: { create: [{ userId: (await localRow("hidy")).id }, { userId: rex.id }] },
      },
    });

    expect((await friendRequest(far, "hidy")).status).toBe(201);
    expect((await conversationWith(far, "hidy")).status).toBe(201);
  });
});

describe("the server's own setting", () => {
  it("narrows what people chose: forced-off hides everyone, whatever they chose, from servers with no relationship", async () => {
    await registerUser("open");
    const far = await registerTestPeer(FAR);
    expect((await lookup(far, "open")).status).toBe(200);

    config.userDiscoverability = "forced-off";

    const res = await lookup(far, "open");
    const request = await friendRequest(far, "open");
    expect([res.status, res.body.error]).toEqual([404, "not_found"]);
    expect([request.status, request.body.error]).toEqual([404, "user_not_found"]);
  });

  it("still leaves a server that has a relationship alone, even when forced off", async () => {
    await registerUser("open");
    const far = await registerTestPeer(FAR);
    const rex = await remoteStub(FAR);
    await prisma.friendship.createMany({
      data: [
        { userId: (await localRow("open")).id, friendId: rex.id },
        { userId: rex.id, friendId: (await localRow("open")).id },
      ],
    });
    config.userDiscoverability = "forced-off";

    expect((await lookup(far, "open")).status).toBe(200);
  });

  it("starts new accounts hidden under default-off, who can then choose to be found", async () => {
    config.userDiscoverability = "default-off";
    const hidy = await registerUser("hidy");
    const far = await registerTestPeer(FAR);

    expect((await localRow("hidy")).discoverable).toBe(false);
    expect((await lookup(far, "hidy")).status).toBe(404);

    await api.patch("/api/v1/users/me").set(authHeader(hidy.accessToken)).send({ discoverable: true });

    expect((await lookup(far, "hidy")).status).toBe(200);
  });

  it("keeps default-on's accounts findable, and lets each person hide", async () => {
    config.userDiscoverability = "default-on";
    await registerUser("open");

    expect((await localRow("open")).discoverable).toBe(true);
  });

  it("starts accounts hidden under forced-off, and refuses a change, saying the server has taken the choice", async () => {
    config.userDiscoverability = "forced-off";
    const hidy = await registerUser("hidy");

    const change = await api.patch("/api/v1/users/me").set(authHeader(hidy.accessToken)).send({ discoverable: true });

    expect((await localRow("hidy")).discoverable).toBe(false);
    expect([change.status, change.body.error]).toEqual([409, "discoverability_locked"]);
    expect((await localRow("hidy")).discoverable).toBe(false);
  });

  it("does not refuse the rest of a profile update when forced off, only the setting", async () => {
    config.userDiscoverability = "forced-off";
    const hidy = await registerUser("hidy");

    const res = await api.patch("/api/v1/users/me").set(authHeader(hidy.accessToken)).send({ bio: "hello" });

    expect(res.status).toBe(200);
    expect(res.body.user.bio).toBe("hello");
  });
});

describe("the setting itself", () => {
  it("is saved, and shown to the person it is about, with whether the server has locked it", async () => {
    const hidy = await registerUser("hidy");

    const patched = await api.patch("/api/v1/users/me").set(authHeader(hidy.accessToken)).send({ discoverable: false });
    const me = await api.get("/api/v1/users/me").set(authHeader(hidy.accessToken));

    expect(patched.body.user).toMatchObject({ discoverable: false, discoverabilityLocked: false });
    expect(me.body.user).toMatchObject({ discoverable: false, discoverabilityLocked: false });
    config.userDiscoverability = "forced-off";
    const locked = await api.get("/api/v1/users/me").set(authHeader(hidy.accessToken));
    expect(locked.body.user.discoverabilityLocked).toBe(true);
  });

  it("is never shown to anyone else: not in another person's view, nor in what another server is told", async () => {
    const hidy = await registerUser("hidy");
    const other = await registerUser("other");
    const far = await registerTestPeer(FAR);

    const view = await api.get(`/api/v1/users/${hidy.user.id}/profile`).set(authHeader(other.accessToken));
    const federated = await lookup(far, "hidy");

    expect(JSON.stringify(view.body)).not.toContain("discoverable");
    expect(JSON.stringify(federated.body)).not.toContain("discoverable");
  });

  it("accepts only true or false", async () => {
    const hidy = await registerUser("hidy");

    for (const value of ["no", 0, null, "false"]) {
      const res = await api.patch("/api/v1/users/me").set(authHeader(hidy.accessToken)).send({ discoverable: value });
      expect([res.status, value]).toEqual([400, value]);
    }
    expect((await localRow("hidy")).discoverable).toBe(true);
  });
});
