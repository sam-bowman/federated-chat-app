// A community owner used to be stuck: no route changed ownership or deleted a community, and the owner
// could not leave. These exercise both ways out against the real app and database - handing the
// community to another local member (password-confirmed, owner only) and deleting it (owner only, with
// everything it owns going too) - and what each tells members and remote servers.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { ALL_PERMISSIONS } from "../../src/lib/permissions.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";

type Registered = Awaited<ReturnType<typeof registerUser>>;
type Community = { id: string; channels: { id: string }[]; roles: { id: string; isDefault: boolean }[] };

async function createCommunity(owner: Registered, name = "Ownership Test"): Promise<Community> {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community;
}

async function join(community: Community, user: Registered) {
  const res = await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken));
  expect(res.status).toBe(201);
}

const dbUser = (user: Registered) => prisma.user.findUniqueOrThrow({ where: { protocolId: user.user.id } });

const transfer = (owner: Registered, community: Community, newOwnerId: string, password = PASSWORD) =>
  api
    .put(`/api/v1/communities/${community.id}/owner`)
    .set(authHeader(owner.accessToken))
    .send({ userId: newOwnerId, password });

const remove = (user: Registered, community: Community) =>
  api.delete(`/api/v1/communities/${community.id}`).set(authHeader(user.accessToken));

/** A cached remote-stub member, as left behind by a real federated join. */
async function addRemoteMember(community: Community, domain: string, username = "remy") {
  const stub = await prisma.user.create({
    data: { protocolId: newProtocolId(), username, displayName: username, homeserverDomain: domain, isRemote: true },
  });
  const row = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
  await prisma.communityMember.create({ data: { communityId: row.id, userId: stub.id } });
  return stub;
}

describe("PUT /communities/:id/owner (transfer ownership)", () => {
  it("hands the community over: the new owner holds everything, the old one is an ordinary member", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);

    const res = await transfer(alice, community, bob.user.id);

    expect(res.status).toBe(200);
    expect(res.body.community.owner.id).toBe(bob.user.id);
    expect((await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } })).ownerId).toBe(
      (await dbUser(bob)).id
    );

    // Bob can now do owner things...
    const rename = await api
      .patch(`/api/v1/communities/${community.id}`)
      .set(authHeader(bob.accessToken))
      .send({ name: "Bob's now" });
    expect(rename.status).toBe(200);
    // ...and Alice, who holds only @everyone, can't.
    const aliceRename = await api
      .patch(`/api/v1/communities/${community.id}`)
      .set(authHeader(alice.accessToken))
      .send({ name: "Still mine?" });
    expect(aliceRename.status).toBe(403);
    const aliceChannel = await api
      .post(`/api/v1/communities/${community.id}/channels`)
      .set(authHeader(alice.accessToken))
      .send({ name: "nope" });
    expect(aliceChannel.status).toBe(403);
  });

  it("lets the former owner leave afterwards, which an owner could not do", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);

    const before = await api.delete(`/api/v1/communities/${community.id}/members/me`).set(authHeader(alice.accessToken));
    expect(before.status).toBe(400);
    expect(before.body.error).toBe("owner_cannot_leave");

    expect((await transfer(alice, community, bob.user.id)).status).toBe(200);

    const after = await api.delete(`/api/v1/communities/${community.id}/members/me`).set(authHeader(alice.accessToken));
    expect(after.status).toBe(204);
  });

  it("makes the former owner an ordinary member who can be kicked, and the new owner un-kickable", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);
    await transfer(alice, community, bob.user.id);

    const kickNewOwner = await api
      .delete(`/api/v1/communities/${community.id}/members/${bob.user.id}`)
      .set(authHeader(alice.accessToken));
    expect(kickNewOwner.status).toBe(403); // Alice no longer holds KICK_MEMBERS at all

    const kickOldOwner = await api
      .delete(`/api/v1/communities/${community.id}/members/${alice.user.id}`)
      .set(authHeader(bob.accessToken));
    expect(kickOldOwner.status).toBe(204);
  });

  it("refuses a wrong password and changes nothing", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);

    const res = await transfer(alice, community, bob.user.id, "Not-The-Password-9!");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
    expect((await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } })).ownerId).toBe(
      (await dbUser(alice)).id
    );
  });

  it("is the owner's alone: a member holding every permission still gets 403", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    await join(community, bob);
    await join(community, carol);
    const role = await api
      .post(`/api/v1/communities/${community.id}/roles`)
      .set(authHeader(alice.accessToken))
      .send({ name: "Everything", permissions: ALL_PERMISSIONS.toString() });
    await api
      .post(`/api/v1/communities/${community.id}/members/${bob.user.id}/roles/${role.body.role.id}`)
      .set(authHeader(alice.accessToken));

    const res = await transfer(bob, community, carol.user.id);

    expect(res.status).toBe(403);
    expect((await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } })).ownerId).toBe(
      (await dbUser(alice)).id
    );
  });

  it("refuses someone who is not a member, the owner themselves, an unknown user and a malformed request", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);

    const notMember = await transfer(alice, community, bob.user.id);
    expect(notMember.status).toBe(404);
    expect(notMember.body.error).toBe("not_a_member");

    const self = await transfer(alice, community, alice.user.id);
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("already_owner");

    const unknown = await transfer(alice, community, newProtocolId());
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("user_not_found");

    const malformed = await api
      .put(`/api/v1/communities/${community.id}/owner`)
      .set(authHeader(alice.accessToken))
      .send({ userId: bob.user.id });
    expect(malformed.status).toBe(400);
  });

  it("refuses a banned user, who is no longer a member", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);
    const ban = await api
      .post(`/api/v1/communities/${community.id}/bans`)
      .set(authHeader(alice.accessToken))
      .send({ protocolId: bob.user.id });
    expect(ban.status).toBeLessThan(300);

    const res = await transfer(alice, community, bob.user.id);

    expect(res.status).toBe(404);
  });

  it("refuses a remote member as the new owner: nobody could manage that community", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const remote = await addRemoteMember(community, "far.example");

    const res = await transfer(alice, community, remote.protocolId);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("new_owner_must_be_local");
    expect((await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } })).ownerId).toBe(
      (await dbUser(alice)).id
    );
  });

  it("is refused for a community hosted on another server", async () => {
    const alice = await registerUser("alice");
    const aliceRow = await dbUser(alice);
    const cached = await prisma.community.create({
      data: { protocolId: newProtocolId(), name: "Far away", ownerId: aliceRow.id, homeserverDomain: "far.example", isRemote: true },
    });

    const res = await api
      .put(`/api/v1/communities/${cached.protocolId}/owner`)
      .set(authHeader(alice.accessToken))
      .send({ userId: newProtocolId(), password: PASSWORD });

    expect(res.status).toBe(409);
  });

  it("tells local members' clients to refresh, and sends remote members' servers a resync ping", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);
    await addRemoteMember(community, "far.example");
    // Joining tells the members too (#220): only what the transfer itself sends is under test here.
    await prisma.syncEvent.deleteMany({ where: { type: "community:updated" } });

    expect((await transfer(alice, community, bob.user.id)).status).toBe(200);

    const refreshed = await prisma.syncEvent.findMany({ where: { type: "community:updated" } });
    expect(refreshed.map((e) => e.recipientId).sort()).toEqual([(await dbUser(alice)).id, (await dbUser(bob)).id].sort());
    const pings = await prisma.federationOutboxEvent.findMany({ where: { path: `/communities/${community.id}/updated` } });
    expect(pings.map((p) => p.domain)).toEqual(["far.example"]);
  });
});

describe("DELETE /communities/:id", () => {
  it("lets the owner delete it, taking channels, messages, roles, memberships and emoticons with it", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);
    await api
      .post(`/api/v1/channels/${community.channels[0].id}/messages`)
      .set(authHeader(bob.accessToken))
      .send({ content: "hello" });
    const row = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
    await prisma.emoticon.create({
      data: {
        protocolId: newProtocolId(),
        creatorId: row.ownerId,
        communityId: row.id,
        name: "party",
        trigger: "party",
        imageUrl: "/uploads/never-existed.png",
      },
    });

    const res = await remove(alice, community);

    expect(res.status).toBe(204);
    expect(await prisma.community.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await prisma.channel.count({ where: { communityId: row.id } })).toBe(0);
    expect(await prisma.role.count({ where: { communityId: row.id } })).toBe(0);
    expect(await prisma.communityMember.count({ where: { communityId: row.id } })).toBe(0);
    expect(await prisma.emoticon.count({ where: { communityId: row.id } })).toBe(0);
    expect(await prisma.message.count({ where: { content: "hello" } })).toBe(0);
    const gone = await api.get(`/api/v1/communities/${community.id}`).set(authHeader(alice.accessToken));
    expect(gone.status).toBe(404);
  });

  it("is the owner's alone: a member holding every permission, a plain member and an outsider get 403", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const dave = await registerUser("dave");
    const community = await createCommunity(alice);
    await join(community, bob);
    await join(community, carol);
    const role = await api
      .post(`/api/v1/communities/${community.id}/roles`)
      .set(authHeader(alice.accessToken))
      .send({ name: "Everything", permissions: ALL_PERMISSIONS.toString() });
    await api
      .post(`/api/v1/communities/${community.id}/members/${bob.user.id}/roles/${role.body.role.id}`)
      .set(authHeader(alice.accessToken));

    for (const who of [bob, carol, dave]) {
      expect((await remove(who, community)).status).toBe(403);
    }
    expect(await prisma.community.count({ where: { protocolId: community.id } })).toBe(1);
  });

  it("answers 404 for an unknown community and 409 for one hosted elsewhere", async () => {
    const alice = await registerUser("alice");
    const aliceRow = await dbUser(alice);
    const cached = await prisma.community.create({
      data: { protocolId: newProtocolId(), name: "Far away", ownerId: aliceRow.id, homeserverDomain: "far.example", isRemote: true },
    });

    expect((await api.delete(`/api/v1/communities/${newProtocolId()}`).set(authHeader(alice.accessToken))).status).toBe(404);
    expect((await api.delete(`/api/v1/communities/${cached.protocolId}`).set(authHeader(alice.accessToken))).status).toBe(409);
    expect(await prisma.community.count({ where: { id: cached.id } })).toBe(1);
  });

  it("tells every local member (and only them) it is gone, and pings each remote member's server", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const outsider = await registerUser("outsider");
    const community = await createCommunity(alice);
    await join(community, bob);
    await addRemoteMember(community, "far.example");
    await addRemoteMember(community, "far.example", "remy2");
    await addRemoteMember(community, "other.example", "otto");

    expect((await remove(alice, community)).status).toBe(204);

    const events = await prisma.syncEvent.findMany({ where: { type: "community:deleted" } });
    expect(events.map((e) => e.recipientId).sort()).toEqual([(await dbUser(alice)).id, (await dbUser(bob)).id].sort());
    expect(events.every((e) => (e.payload as { communityId: string }).communityId === community.id)).toBe(true);
    expect(await prisma.syncEvent.count({ where: { recipientId: (await dbUser(outsider)).id, type: "community:deleted" } })).toBe(0);

    const pings = await prisma.federationOutboxEvent.findMany({ where: { path: `/communities/${community.id}/updated` } });
    expect(pings.map((p) => p.domain).sort()).toEqual(["far.example", "other.example"]);
  });

  describe("uploaded files", () => {
    const written: string[] = [];
    const filePath = (name: string) => path.join(path.resolve(config.uploadsDir), name);

    function makeUpload(label: string) {
      const name = `ownership-test-${label}-${newProtocolId()}.png`;
      fs.mkdirSync(path.resolve(config.uploadsDir), { recursive: true });
      fs.writeFileSync(filePath(name), "x");
      written.push(name);
      return { name, url: `/uploads/${name}` };
    }

    afterEach(() => {
      for (const name of written.splice(0)) fs.rmSync(filePath(name), { force: true });
    });

    it("removes the community's icon, attachments and emoticon images, but keeps one that something else still uses", async () => {
      const alice = await registerUser("alice");
      const community = await createCommunity(alice);
      const row = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
      const icon = makeUpload("icon");
      const attachment = makeUpload("attachment");
      const emoticon = makeUpload("emoticon");
      const shared = makeUpload("shared"); // the owner's avatar AND an attachment in the community
      const message = await prisma.message.create({
        data: { protocolId: newProtocolId(), channelId: (await prisma.channel.findFirstOrThrow({ where: { communityId: row.id } })).id, senderId: row.ownerId, content: "files" },
      });
      await prisma.community.update({ where: { id: row.id }, data: { iconUrl: icon.url } });
      for (const upload of [attachment, shared]) {
        await prisma.attachment.create({
          data: { messageId: message.id, url: upload.url, filename: upload.name, contentType: "image/png", size: 1 },
        });
      }
      await prisma.emoticon.create({
        data: { protocolId: newProtocolId(), creatorId: row.ownerId, communityId: row.id, name: "e", trigger: "e", imageUrl: emoticon.url },
      });
      await prisma.user.update({ where: { id: row.ownerId }, data: { avatarUrl: shared.url } });

      expect((await remove(alice, community)).status).toBe(204);

      expect(fs.existsSync(filePath(icon.name))).toBe(false);
      expect(fs.existsSync(filePath(attachment.name))).toBe(false);
      expect(fs.existsSync(filePath(emoticon.name))).toBe(false);
      expect(fs.existsSync(filePath(shared.name))).toBe(true);
    });

    it("never fails the deletion over a file it cannot delete (already gone, or not ours)", async () => {
      const alice = await registerUser("alice");
      const community = await createCommunity(alice);
      const row = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
      await prisma.community.update({ where: { id: row.id }, data: { iconUrl: "https://elsewhere.example/icon.png" } });
      const message = await prisma.message.create({
        data: { protocolId: newProtocolId(), channelId: (await prisma.channel.findFirstOrThrow({ where: { communityId: row.id } })).id, senderId: row.ownerId, content: "gone" },
      });
      await prisma.attachment.create({
        data: { messageId: message.id, url: "/uploads/already-gone.png", filename: "x.png", contentType: "image/png", size: 1 },
      });

      expect((await remove(alice, community)).status).toBe(204);
    });
  });
});
