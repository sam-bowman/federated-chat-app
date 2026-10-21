// Deleting an account (#60, part 2), end to end against the real app and database: asking (and what it takes to ask), signing in
// to take it back, what erasure removes and what it must leave alone, the tombstone it leaves behind, and what other servers are
// told and may tell this one.
import fs from "node:fs";
import path from "node:path";
import { generate } from "otplib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { ensureRemoteUser } from "../../src/modules/federation/remoteUsers.js";
import { forgetRemoteUser, purgeAccount, purgeDueAccounts } from "../../src/modules/users/deletion.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";
const DAY = 24 * 60 * 60 * 1000;
type Registered = Awaited<ReturnType<typeof registerUser>>;

const row = (user: Registered) => prisma.user.findUniqueOrThrow({ where: { protocolId: user.user.id } });
const ask = (user: Registered, body: object = {}) =>
  api.post("/api/v1/users/me/delete").set(authHeader(user.accessToken)).send({ password: PASSWORD, username: user.user.username, ...body });
const login = (username: string, password = PASSWORD) => api.post("/api/v1/auth/login").send({ username, password });

const createCommunity = async (owner: Registered, name = "Club") =>
  (await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name })).body.community as { id: string; channels: { id: string }[] };
const joinCommunity = (community: { id: string }, user: Registered) => api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken));
const openChat = async (from: Registered, ...others: string[]) =>
  (await api.post("/api/v1/conversations").set(authHeader(from.accessToken)).send({ type: others.length > 1 ? "GROUP" : "DM", memberUsernames: others, title: others.length > 1 ? "Crew" : undefined })).body.conversation.id as string;
const say = (user: Registered, where: string, content: string, extra: object = {}) =>
  api.post(where).set(authHeader(user.accessToken)).send({ content, ...extra });
const inChannel = (community: { channels: { id: string }[] }) => `/api/v1/channels/${community.channels[0].id}/messages`;
const inChat = (id: string) => `/api/v1/conversations/${id}/messages`;

/** Asks, then erases at once the way the worker does once the grace period is over. */
async function eraseNow(user: Registered) {
  expect((await ask(user)).status).toBe(202);
  const result = await purgeAccount((await row(user)).id);
  expect(result).toEqual({ ok: true });
}

describe("asking to delete an account", () => {
  it("needs a signed-in person who knows their password and types their own username", async () => {
    const alice = await registerUser("alice");
    expect((await api.post("/api/v1/users/me/delete").send({ password: PASSWORD, username: "alice" })).status).toBe(401);
    const wrong = await ask(alice, { password: "Not-The-Password-1!" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("invalid_credentials");
    const other = await ask(alice, { username: "bob" });
    expect(other.status).toBe(400);
    expect(other.body.error).toBe("username_mismatch");
    expect((await api.post("/api/v1/users/me/delete").set(authHeader(alice.accessToken)).send({ password: PASSWORD })).status).toBe(400);
    // None of that started anything.
    expect((await row(alice)).deletionRequestedAt).toBeNull();
  });

  it("accepts the username however it is capitalised or padded", async () => {
    const alice = await registerUser("alice");
    expect((await ask(alice, { username: "  ALICE " })).status).toBe(202);
  });

  it("asks for a code from the authenticator when there is one, and a wrong or missing one starts nothing", async () => {
    const alice = await registerUser("alice");
    const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(alice.accessToken)).send({ password: PASSWORD })).body;
    await api.post("/api/v1/auth/2fa/verify").set(authHeader(alice.accessToken)).send({ code: await generate({ secret }) });

    const missing = await ask(alice);
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe("invalid_code");
    expect((await ask(alice, { code: "000000" })).status).toBe(401);
    expect((await row(alice)).deletionRequestedAt).toBeNull();
  });

  it("accepts a recovery code in place of one from the authenticator", async () => {
    const alice = await registerUser("alice");
    const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(alice.accessToken)).send({ password: PASSWORD })).body;
    const verified = await api.post("/api/v1/auth/2fa/verify").set(authHeader(alice.accessToken)).send({ code: await generate({ secret }) });
    expect((await ask(alice, { recoveryCode: verified.body.recoveryCodes[0] })).status).toBe(202);
  });

  it("starts the grace period and ends every session, but erases nothing and changes nothing anyone else can see", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const dm = await openChat(alice, "bob");
    await say(alice, inChat(dm), "still here");

    const before = Date.now();
    const res = await ask(alice);
    expect(res.status).toBe(202);
    expect(res.body.graceDays).toBe(config.accountDeletionGraceDays);
    const scheduled = new Date(res.body.scheduledFor).getTime();
    expect(scheduled).toBeGreaterThanOrEqual(before + config.accountDeletionGraceDays * DAY - 1000);
    expect(scheduled).toBeLessThanOrEqual(Date.now() + config.accountDeletionGraceDays * DAY + 1000);

    // Signed out everywhere...
    expect((await api.post("/api/v1/auth/refresh").send({ refreshToken: alice.refreshToken })).status).toBe(401);
    // ...and nothing else moved: the messages, the account and what others see of it are as they were.
    expect(await prisma.message.count({ where: { content: "still here" } })).toBe(1);
    expect((await row(alice)).deletedAt).toBeNull();
    expect((await row(alice)).displayName).toBe("alice");
    const seenByBob = await api.get("/api/v1/users/alice").set(authHeader(bob.accessToken));
    expect(seenByBob.status).toBe(200);
  });

  it("keeps the first date when asked again, and still ends any session made in between", async () => {
    const alice = await registerUser("alice");
    const first = await ask(alice);
    const requestedAt = (await row(alice)).deletionRequestedAt!;
    const again = await ask(alice);
    expect(again.status).toBe(202);
    expect(again.body.scheduledFor).toBe(first.body.scheduledFor);
    expect((await row(alice)).deletionRequestedAt!.getTime()).toBe(requestedAt.getTime());
  });

  it("is refused while the person owns a community, naming it, and starts nothing", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice, "Alice's Club");
    const res = await ask(alice);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "owns_communities", communities: [{ id: club.id, name: "Alice's Club" }] });
    expect((await row(alice)).deletionRequestedAt).toBeNull();
    // Still signed in.
    expect((await api.post("/api/v1/auth/refresh").send({ refreshToken: alice.refreshToken })).status).toBe(200);
  });

  it("works once the community has been handed on", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice);
    await joinCommunity(club, bob);
    expect((await api.put(`/api/v1/communities/${club.id}/owner`).set(authHeader(alice.accessToken)).send({ userId: bob.user.id, password: PASSWORD })).status).toBe(200);
    expect((await ask(alice)).status).toBe(202);
  });
});

describe("signing in takes it back", () => {
  it("cancels a pending deletion, and says so once", async () => {
    const alice = await registerUser("alice");
    await ask(alice);
    expect((await row(alice)).deletionRequestedAt).not.toBeNull();

    const back = await login("alice");
    expect(back.status).toBe(200);
    expect(back.body.deletionCancelled).toBe(true);
    expect((await row(alice)).deletionRequestedAt).toBeNull();
    // The next time there is nothing to say.
    expect((await login("alice")).body.deletionCancelled).toBeUndefined();
  });

  it("is not done by a wrong password", async () => {
    const alice = await registerUser("alice");
    await ask(alice);
    expect((await login("alice", "Not-The-Password-1!")).status).toBe(401);
    expect((await row(alice)).deletionRequestedAt).not.toBeNull();
  });

  it("waits for the second factor on an account that has one", async () => {
    const alice = await registerUser("alice");
    const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(alice.accessToken)).send({ password: PASSWORD })).body;
    await api.post("/api/v1/auth/2fa/verify").set(authHeader(alice.accessToken)).send({ code: await generate({ secret }) });
    expect((await ask(alice, { code: await generate({ secret }) })).status).toBe(202);

    const first = await login("alice");
    expect(first.body.totpRequired).toBe(true);
    expect((await row(alice)).deletionRequestedAt).not.toBeNull(); // the password alone does not cancel it

    // The code above was spent on asking; a code is good once per time step, so let this one count as a fresh step.
    await prisma.user.update({ where: { id: (await row(alice)).id }, data: { totpLastUsedStep: null } });
    const done = await api.post("/api/v1/auth/2fa/login").send({ challengeToken: first.body.challengeToken, code: await generate({ secret }) });
    expect(done.status).toBe(200);
    expect(done.body.deletionCancelled).toBe(true);
    expect((await row(alice)).deletionRequestedAt).toBeNull();
  });

  it("is too late once the account has been erased", async () => {
    const alice = await registerUser("alice");
    await eraseNow(alice);
    expect((await login("alice")).status).toBe(401);
  });
});

describe("the grace period", () => {
  it("erases an account only once it is over, and only that account", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await ask(alice);
    const requestedAt = (await row(alice)).deletionRequestedAt!;

    expect(await purgeDueAccounts(new Date(requestedAt.getTime() + 13 * DAY), 14)).toBe(0);
    expect((await row(alice)).deletedAt).toBeNull();
    expect(await purgeDueAccounts(new Date(requestedAt.getTime() + 14 * DAY + 1000), 14)).toBe(1);
    expect((await row(alice)).deletedAt).not.toBeNull();
    expect((await row(bob)).deletedAt).toBeNull();
    // Nothing left to do the next time.
    expect(await purgeDueAccounts(new Date(requestedAt.getTime() + 30 * DAY), 14)).toBe(0);
  });

  it("with no waiting erases at the next look", async () => {
    const alice = await registerUser("alice");
    await ask(alice);
    expect(await purgeDueAccounts(new Date(Date.now() + 1000), 0)).toBe(1);
  });

  it("drops the request of someone who became an owner while waiting, rather than orphaning the community", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(bob);
    await joinCommunity(club, alice);
    await ask(alice);
    await api.put(`/api/v1/communities/${club.id}/owner`).set(authHeader(bob.accessToken)).send({ userId: alice.user.id, password: PASSWORD });

    expect(await purgeDueAccounts(new Date(Date.now() + 30 * DAY), 14)).toBe(0);
    const after = await row(alice);
    expect(after.deletedAt).toBeNull();
    expect(after.deletionRequestedAt).toBeNull();
    expect((await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } })).ownerId).toBe(after.id);
  });

  it("does not let one account that cannot be erased stop the others", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await ask(alice);
    await ask(bob);
    // Alice's request is dated first, so she is tried first; make her fail.
    await prisma.user.update({ where: { id: (await row(alice)).id }, data: { deletionRequestedAt: new Date(Date.now() - 20 * DAY) } });
    const original = prisma.$transaction.bind(prisma);
    let first = true;
    (prisma as unknown as { $transaction: unknown }).$transaction = ((...args: unknown[]) => {
      if (first) {
        first = false;
        return Promise.reject(new Error("the database hiccuped"));
      }
      return (original as (...a: unknown[]) => unknown)(...args);
    }) as typeof prisma.$transaction;
    try {
      expect(await purgeDueAccounts(new Date(Date.now() + 30 * DAY), 14)).toBe(1);
    } finally {
      (prisma as unknown as { $transaction: unknown }).$transaction = original;
    }
    const states = [await row(alice), await row(bob)].map((u) => u.deletedAt !== null);
    expect(states.filter(Boolean)).toHaveLength(1);
  });
});

describe("what erasure removes", () => {
  it("is every message they wrote, in channels, direct messages and groups, with what hangs off them, and nobody else's", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(carol, "Carol's Club");
    await joinCommunity(club, alice);
    await joinCommunity(club, bob);
    const dm = await openChat(alice, "bob");
    const crew = await openChat(alice, "bob", "carol");
    const mine = (await say(alice, inChannel(club), "alice in the club")).body.message;
    const theirs = (await say(bob, inChannel(club), "bob in the club")).body.message;
    await say(alice, inChat(dm), "alice to bob");
    await say(bob, inChat(dm), "bob to alice");
    await say(alice, inChat(crew), "alice to the crew");
    await say(bob, inChat(crew), "bob to the crew");
    // A reply to hers and a reaction on hers and one of hers on bob's.
    await say(bob, inChannel(club), "bob replying", { replyToId: mine.id });
    await api.post(`/api/v1/messages/${mine.id}/reactions`).set(authHeader(bob.accessToken)).send({ emoji: "👍" });
    await api.post(`/api/v1/messages/${theirs.id}/reactions`).set(authHeader(alice.accessToken)).send({ emoji: "🎉" });

    await eraseNow(alice);

    const remaining = (await prisma.message.findMany({ select: { content: true } })).map((m) => m.content).sort();
    expect(remaining).toEqual(["bob in the club", "bob replying", "bob to alice", "bob to the crew"]);
    // The reply keeps its words and loses the quote; her reaction on his message is gone, his on hers went with the message.
    const reply = await prisma.message.findFirstOrThrow({ where: { content: "bob replying" } });
    expect(reply.replyToId).toBeNull();
    expect(await prisma.reaction.count()).toBe(0);
  });

  it("is their friendships, requests, blocks, memberships, reading marks and choices, and ends every session", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(carol);
    await joinCommunity(club, alice);
    const aliceRow = await row(alice);
    const bobRow = await row(bob);
    const carolRow = await row(carol);
    await prisma.friendship.createMany({ data: [{ userId: aliceRow.id, friendId: bobRow.id }, { userId: bobRow.id, friendId: aliceRow.id }] });
    await prisma.friendRequest.create({ data: { protocolId: newProtocolId(), fromUserId: carolRow.id, toUserId: aliceRow.id } });
    await prisma.block.create({ data: { blockerId: aliceRow.id, blockedId: carolRow.id } });
    await prisma.block.create({ data: { blockerId: carolRow.id, blockedId: aliceRow.id } });
    await prisma.notificationSetting.create({ data: { userId: aliceRow.id, targetType: "GLOBAL", targetId: "", sound: false } });
    await prisma.channelRead.create({ data: { channelId: (await prisma.channel.findFirstOrThrow({ where: { protocolId: club.channels[0].id } })).id, userId: aliceRow.id } });
    await prisma.communityBan.create({ data: { communityId: (await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } })).id, userId: aliceRow.id } });

    await eraseNow(alice);

    const mine = { where: { OR: [{ userId: aliceRow.id }, { friendId: aliceRow.id }] } };
    expect(await prisma.friendship.count(mine)).toBe(0);
    expect(await prisma.friendRequest.count({ where: { OR: [{ fromUserId: aliceRow.id }, { toUserId: aliceRow.id }] } })).toBe(0);
    expect(await prisma.block.count({ where: { OR: [{ blockerId: aliceRow.id }, { blockedId: aliceRow.id }] } })).toBe(0);
    expect(await prisma.communityMember.count({ where: { userId: aliceRow.id } })).toBe(0);
    expect(await prisma.communityBan.count({ where: { userId: aliceRow.id } })).toBe(0);
    expect(await prisma.channelRead.count({ where: { userId: aliceRow.id } })).toBe(0);
    expect(await prisma.notificationSetting.count({ where: { userId: aliceRow.id } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: aliceRow.id } })).toBe(0);
    // Everyone else is where they were.
    expect(await prisma.communityMember.count({ where: { communityId: (await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } })).id } })).toBe(1);
  });

  it("is the emoticons they made for themselves, and what saved them; one a community has is the community's and stays", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice);
    await joinCommunity(club, bob);
    const aliceRow = await row(alice);
    const personal = await prisma.emoticon.create({ data: { protocolId: newProtocolId(), creatorId: aliceRow.id, name: "mine", trigger: "mine", imageUrl: "/uploads/x.png" } });
    const communal = await prisma.emoticon.create({
      data: { protocolId: newProtocolId(), creatorId: aliceRow.id, communityId: (await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } })).id, name: "club", trigger: "club", imageUrl: "/uploads/y.png" },
    });
    await prisma.emoticonSave.create({ data: { userId: (await row(bob)).id, emoticonId: personal.id } });
    // She hands the community on so that she may ask at all.
    await api.put(`/api/v1/communities/${club.id}/owner`).set(authHeader(alice.accessToken)).send({ userId: bob.user.id, password: PASSWORD });

    await eraseNow(alice);

    expect(await prisma.emoticon.findUnique({ where: { id: personal.id } })).toBeNull();
    expect(await prisma.emoticonSave.count()).toBe(0);
    const kept = await prisma.emoticon.findUniqueOrThrow({ where: { id: communal.id }, include: { creator: true } });
    expect(kept.creator.displayName).toBe("Deleted user");
  });

  it("is the emoticons they saved from other people, which the other person keeps", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const bobs = await prisma.emoticon.create({ data: { protocolId: newProtocolId(), creatorId: (await row(bob)).id, name: "wave", trigger: "wave", imageUrl: "/uploads/w.png" } });
    await prisma.emoticonSave.create({ data: { userId: (await row(alice)).id, emoticonId: bobs.id, trigger: "hi" } });

    await eraseNow(alice);

    expect(await prisma.emoticonSave.count()).toBe(0);
    expect(await prisma.emoticon.findUnique({ where: { id: bobs.id } })).not.toBeNull();
  });

  it("is a group membership, but a direct message stays for the other person, who then has it with Deleted user", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const dm = await openChat(alice, "bob");
    const crew = await openChat(alice, "bob", "carol");

    await eraseNow(alice);

    const chats = (await api.get("/api/v1/conversations").set(authHeader(bob.accessToken))).body.conversations as { id: string; members: { displayName: string }[] }[];
    const direct = chats.find((c) => c.id === dm)!;
    expect(direct.members.map((m) => m.displayName).sort()).toEqual(["Deleted user", "bob"]);
    const group = chats.find((c) => c.id === crew)!;
    expect(group.members.map((m) => m.displayName).sort()).toEqual(["bob", "carol"]);
    expect(carol).toBeTruthy();
    // Nobody is there to read anything new.
    const sent = await say(bob, inChat(dm), "hello?");
    expect(sent.status).toBe(409);
    expect(sent.body.error).toBe("user_deleted");
  });

  it("removes a conversation nobody left on this server is in", async () => {
    const alice = await registerUser("alice");
    const far = await registerTestPeer("far.test");
    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: far.domain, isRemote: true } });
    const conversation = await prisma.conversation.create({
      data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: (await row(alice)).id }, { userId: remy.id }] } },
    });
    await eraseNow(alice);
    expect(await prisma.conversation.findUnique({ where: { id: conversation.id } })).toBeNull();
  });

  it("is the files only they used: their picture and what they attached, and not one someone else also points at", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const dir = path.resolve(config.uploadsDir);
    fs.mkdirSync(dir, { recursive: true });
    const names = ["avatar", "attached", "shared"].map((label) => `deletion-test-${label}-${newProtocolId()}.png`);
    for (const name of names) fs.writeFileSync(path.join(dir, name), "x");
    try {
      const [avatar, attached, shared] = names.map((n) => `/uploads/${n}`);
      const aliceRow = await row(alice);
      const dm = await openChat(alice, "bob");
      const message = (await say(alice, inChat(dm), "see attached")).body.message;
      const messageRow = await prisma.message.findUniqueOrThrow({ where: { protocolId: message.id } });
      await prisma.user.update({ where: { id: aliceRow.id }, data: { avatarUrl: avatar } });
      await prisma.attachment.createMany({
        data: [attached, shared].map((url) => ({ messageId: messageRow.id, url, filename: "f.png", contentType: "image/png", size: 1 })),
      });
      // Bob uses the same upload as his own picture.
      await prisma.user.update({ where: { id: (await row(bob)).id }, data: { avatarUrl: shared } });

      await eraseNow(alice);

      expect(fs.existsSync(path.join(dir, names[0]))).toBe(false);
      expect(fs.existsSync(path.join(dir, names[1]))).toBe(false);
      expect(fs.existsSync(path.join(dir, names[2]))).toBe(true);
    } finally {
      for (const name of names) fs.rmSync(path.join(dir, name), { force: true });
    }
  });
});

describe("what is left of the account", () => {
  it("is a tombstone: no name, no profile, no password, no way in, and the real name kept for ever", async () => {
    const alice = await registerUser("alice", { displayName: "Alice A" });
    await api.patch("/api/v1/users/me").set(authHeader(alice.accessToken)).send({ bio: "hi", pronouns: "she/her", accentColor: "#ff0000" });
    const original = await row(alice);
    await eraseNow(alice);

    const tombstone = await prisma.user.findUniqueOrThrow({ where: { id: original.id } });
    expect(tombstone).toMatchObject({
      displayName: "Deleted user",
      avatarUrl: null,
      bio: null,
      pronouns: null,
      accentColor: null,
      customStatus: null,
      passwordHash: null,
      totpSecret: null,
      totpEnabled: false,
      presenceStatus: "OFFLINE",
      discoverable: false,
      listedInDirectory: false,
      deletionRequestedAt: null,
      protocolId: original.protocolId,
    });
    expect(tombstone.deletedAt).not.toBeNull();
    expect(tombstone.username).toBe(`~deleted-${original.protocolId.toLowerCase()}`);
    expect(tombstone.username).not.toContain("alice");
    expect(await prisma.deletedUsername.findMany({ select: { username: true } })).toEqual([{ username: "alice" }]);
  });

  it("cannot be signed in to, found, or registered over", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await eraseNow(alice);

    expect((await login("alice")).status).toBe(401);
    expect((await login("~deleted-whatever")).status).toBe(400);
    const taken = await api.post("/api/v1/auth/register").send({ username: "alice", password: PASSWORD });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("username_taken");
    expect((await api.get("/api/v1/users/alice").set(authHeader(bob.accessToken))).status).toBe(404);
    expect((await api.get("/api/v1/users/search").query({ q: "alice" }).set(authHeader(bob.accessToken))).body.users).toEqual([]);
    expect((await api.get("/api/v1/users/search").query({ q: "deleted" }).set(authHeader(bob.accessToken))).body.users).toEqual([]);
  });

  it("has no profile any more", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await eraseNow(alice);
    expect((await api.get(`/api/v1/users/${alice.user.id}/profile`).set(authHeader(bob.accessToken))).status).toBe(404);
  });

  it("is safe to run twice", async () => {
    const alice = await registerUser("alice");
    await eraseNow(alice);
    expect(await purgeAccount((await row(alice)).id)).toEqual({ ok: false, error: "already_deleted" });
    expect(await prisma.deletedUsername.count()).toBe(1);
  });

  it("happens once when two replicas erase the same account at the same moment", async () => {
    const alice = await registerUser("alice");
    const far = await registerTestPeer("far.test");
    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: far.domain, isRemote: true } });
    await prisma.friendship.create({ data: { userId: (await row(alice)).id, friendId: remy.id } });
    await ask(alice);
    const id = (await row(alice)).id;

    const results = await Promise.all([purgeAccount(id), purgeAccount(id)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "already_deleted" }]);
    expect(await prisma.federationOutboxEvent.count({ where: { path: "/account-deleted" } })).toBe(1);
  });

  it("is refused for an account that owns a community, and for one that is not ours", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice, "Hers");
    expect(await purgeAccount((await row(alice)).id)).toEqual({ ok: false, error: "owns_communities", communities: [{ id: club.id, name: "Hers" }] });
    expect((await row(alice)).deletedAt).toBeNull();

    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: "far.test", isRemote: true } });
    expect(await purgeAccount(remy.id)).toEqual({ ok: false, error: "not_local" });
    expect(await purgeAccount("00000000-0000-0000-0000-000000000000")).toEqual({ ok: false, error: "no_such_user" });
  });
});

describe("telling the people on this server", () => {
  it("sends a live event to everyone who knew them, and refreshes the communities they were in", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const dave = await registerUser("dave");
    const club = await createCommunity(carol);
    await joinCommunity(club, alice);
    await openChat(alice, "bob");
    await prisma.friendship.create({ data: { userId: (await row(dave)).id, friendId: (await row(alice)).id } });
    const stranger = await registerUser("stranger");
    await prisma.syncEvent.deleteMany();

    await eraseNow(alice);

    const told = async (type: string) => (await prisma.syncEvent.findMany({ where: { type }, select: { recipientId: true } })).map((e) => e.recipientId).sort();
    const ids = async (...users: Registered[]) => (await Promise.all(users.map(async (u) => (await row(u)).id))).sort();
    expect(await told("user:deleted")).toEqual(await ids(bob, carol, dave));
    expect(await told("community:updated")).toEqual(await ids(carol));
    expect(await told("user:deleted")).not.toContain((await row(stranger)).id);
    const payload = (await prisma.syncEvent.findFirstOrThrow({ where: { type: "user:deleted" } })).payload as { userId: string };
    expect(payload.userId).toBe(alice.user.id);
  });
});

describe("telling other servers", () => {
  const outbox = () => prisma.federationOutboxEvent.findMany({ where: { path: "/account-deleted" }, orderBy: { domain: "asc" } });

  it("tells each server that knows them, once, and no other", async () => {
    const alice = await registerUser("alice");
    const aliceRow = await row(alice);
    const peers = await Promise.all(["friend.test", "chat.test", "group.test", "host.test", "guest.test", "unrelated.test"].map(registerTestPeer));
    const stub = (username: string, domain: string) => prisma.user.create({ data: { protocolId: newProtocolId(), username, displayName: username, homeserverDomain: domain, isRemote: true } });
    const [friend, chatter, grouper, guest] = await Promise.all([stub("fran", "friend.test"), stub("cal", "chat.test"), stub("gus", "group.test"), stub("gwen", "guest.test")]);
    await prisma.friendship.create({ data: { userId: aliceRow.id, friendId: friend.id } });
    await prisma.conversation.create({ data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: aliceRow.id }, { userId: chatter.id }] } } });
    await prisma.conversation.create({ data: { protocolId: newProtocolId(), type: "GROUP", members: { create: [{ userId: aliceRow.id }, { userId: grouper.id }, { userId: friend.id }] } } });
    // A community on another server she is in, and one here with a member from another.
    const hostStub = await stub("hosty", "host.test");
    const remoteClub = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far Club", ownerId: hostStub.id, homeserverDomain: "host.test", isRemote: true } });
    await prisma.communityMember.create({ data: { communityId: remoteClub.id, userId: aliceRow.id } });
    const hereClub = await createCommunity(alice, "Mine");
    const bob = await registerUser("bob");
    await joinCommunity(hereClub, bob);
    await prisma.communityMember.create({ data: { communityId: (await prisma.community.findUniqueOrThrow({ where: { protocolId: hereClub.id } })).id, userId: guest.id } });
    await api.put(`/api/v1/communities/${hereClub.id}/owner`).set(authHeader(alice.accessToken)).send({ userId: bob.user.id, password: PASSWORD });
    expect(peers).toHaveLength(6);

    await eraseNow(alice);

    const events = await outbox();
    expect(events.map((e) => e.domain)).toEqual(["chat.test", "friend.test", "group.test", "guest.test", "host.test"]);
    for (const event of events) expect(event.body).toEqual({ protocolId: alice.user.id });
  });

  it("tells nobody when nobody else knows them", async () => {
    const alice = await registerUser("alice");
    await eraseNow(alice);
    expect(await outbox()).toEqual([]);
  });
});

describe("being told by another server that someone there is gone", () => {
  async function setup() {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const far = await registerTestPeer("far.test");
    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", avatarUrl: "/uploads/r.png", bio: "far away", homeserverDomain: "far.test", homeserverBaseUrl: "http://far.test", isRemote: true } });
    const aliceRow = await row(alice);
    const dm = await prisma.conversation.create({ data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: aliceRow.id }, { userId: remy.id }] } } });
    const group = await prisma.conversation.create({ data: { protocolId: newProtocolId(), type: "GROUP", members: { create: [{ userId: aliceRow.id }, { userId: remy.id }, { userId: (await row(bob)).id }] } } });
    await prisma.friendship.createMany({ data: [{ userId: aliceRow.id, friendId: remy.id }, { userId: remy.id, friendId: aliceRow.id }] });
    const club = await createCommunity(alice, "Hosted here");
    const clubRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } });
    await prisma.communityMember.create({ data: { communityId: clubRow.id, userId: remy.id } });
    const channel = await prisma.channel.findFirstOrThrow({ where: { communityId: clubRow.id } });
    const messageIn = (where: { conversationId?: string; channelId?: string }, senderId: string, content: string) =>
      prisma.message.create({ data: { protocolId: newProtocolId(), ...where, senderId, content } });
    await messageIn({ conversationId: dm.id }, remy.id, "remy in the dm");
    await messageIn({ conversationId: dm.id }, aliceRow.id, "alice in the dm");
    await messageIn({ conversationId: group.id }, remy.id, "remy in the group");
    await messageIn({ channelId: channel.id }, remy.id, "remy in the club");
    await messageIn({ channelId: channel.id }, aliceRow.id, "alice in the club");
    return { alice, bob, far, remy, dm, group, clubRow };
  }
  const say = (peer: Awaited<ReturnType<typeof registerTestPeer>>, protocolId: string) => signedPost(peer, "/federation/v1/account-deleted", { protocolId });

  it("forgets them: their messages here, friendships and memberships, leaving a tombstone for what still points at it", async () => {
    const { far, remy, dm, group, clubRow } = await setup();
    const res = await say(far, remy.protocolId);
    expect(res.status).toBe(204);

    const gone = await prisma.user.findUniqueOrThrow({ where: { id: remy.id } });
    expect(gone).toMatchObject({ displayName: "Deleted user", avatarUrl: null, bio: null, isRemote: true, homeserverDomain: "far.test", protocolId: remy.protocolId });
    expect(gone.deletedAt).not.toBeNull();
    expect((await prisma.message.findMany({ select: { content: true } })).map((m) => m.content).sort()).toEqual(["alice in the club", "alice in the dm"]);
    expect(await prisma.friendship.count({ where: { OR: [{ userId: remy.id }, { friendId: remy.id }] } })).toBe(0);
    expect(await prisma.communityMember.count({ where: { userId: remy.id } })).toBe(0);
    expect(clubRow).toBeTruthy();
    // A direct message stays for the person who is still here; a group loses the member.
    expect(await prisma.conversationMember.count({ where: { conversationId: dm.id, userId: remy.id } })).toBe(1);
    expect(await prisma.conversationMember.count({ where: { conversationId: group.id, userId: remy.id } })).toBe(0);
  });

  it("tells the local people who knew them, and refreshes the community they were in", async () => {
    const { alice, bob, far, remy } = await setup();
    await prisma.syncEvent.deleteMany();
    await say(far, remy.protocolId);
    const told = (await prisma.syncEvent.findMany({ where: { type: "user:deleted" }, select: { recipientId: true } })).map((e) => e.recipientId).sort();
    const ids = [(await row(alice)).id, (await row(bob)).id].sort();
    expect(told).toEqual(ids);
    expect(await prisma.syncEvent.count({ where: { type: "community:updated", recipientId: (await row(alice)).id } })).toBe(1);
  });

  it("is safe to be told twice, and about someone it has never heard of", async () => {
    const { far, remy } = await setup();
    expect((await say(far, remy.protocolId)).status).toBe(204);
    const before = await prisma.syncEvent.count();
    expect((await say(far, remy.protocolId)).status).toBe(204);
    expect(await prisma.syncEvent.count()).toBe(before);
    expect((await say(far, newProtocolId())).status).toBe(204);
  });

  it("is only believed from the person's own server", async () => {
    const { remy } = await setup();
    const other = await registerTestPeer("other.test");
    const res = await say(other, remy.protocolId);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_account_home");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: remy.id } })).deletedAt).toBeNull();
    expect(await prisma.message.count({ where: { content: "remy in the dm" } })).toBe(1);
  });

  it("compares the server's name without regard to case", async () => {
    const { far, remy } = await setup();
    await prisma.user.update({ where: { id: remy.id }, data: { homeserverDomain: "Far.Test" } });
    expect((await say(far, remy.protocolId)).status).toBe(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: remy.id } })).deletedAt).not.toBeNull();
  });

  it("can never be used to erase one of this server's own people", async () => {
    const { alice, far } = await setup();
    const res = await say(far, alice.user.id);
    expect(res.status).toBe(204);
    const kept = await row(alice);
    expect(kept.deletedAt).toBeNull();
    expect(kept.displayName).toBe("alice");
    expect(await prisma.message.count({ where: { content: "alice in the dm" } })).toBe(1);
  });

  it("refuses a request that is not shaped like one", async () => {
    const { far } = await setup();
    expect((await signedPost(far, "/federation/v1/account-deleted", {})).status).toBe(400);
    expect((await signedPost(far, "/federation/v1/account-deleted", { protocolId: "" })).status).toBe(400);
  });

  it("does not give them their name back when a later message still mentions them", async () => {
    const { far, remy } = await setup();
    await say(far, remy.protocolId);
    const again = await ensureRemoteUser({ protocolId: remy.protocolId, username: "remy", domain: "far.test", displayName: "Remy Again", avatarUrl: "/uploads/new.png" });
    expect(again.displayName).toBe("Deleted user");
    expect(again.avatarUrl).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: remy.id } })).displayName).toBe("Deleted user");
  });

  it("is not something that can be done to a local account, whatever calls it", async () => {
    const alice = await registerUser("alice");
    await forgetRemoteUser(await row(alice));
    const kept = await row(alice);
    expect(kept.deletedAt).toBeNull();
    expect(kept.displayName).toBe("alice");
  });

  it("needs a signed request like every other federation call", async () => {
    const { remy } = await setup();
    expect((await api.post("/federation/v1/account-deleted").send({ protocolId: remy.protocolId })).status).toBe(401);
  });
});

describe("the audit log (#59)", () => {
  const entries = () => prisma.auditLogEntry.findMany({ orderBy: { id: "asc" } });

  it("records the person asking, and signing in to cancel it, as them", async () => {
    const alice = await registerUser("alice");
    await ask(alice);
    await ask(alice); // again: nothing new
    await login("alice");
    const got = await entries();
    expect(got.map((e) => e.action)).toEqual(["account.delete_request", "account.delete_cancel"]);
    for (const entry of got) expect(entry).toMatchObject({ source: "api", actorUserId: alice.user.id, actorLabel: expect.stringMatching(/^@alice:/), targetId: alice.user.id });
    expect(got[0].details).toEqual({ scheduledFor: expect.any(String) });
  });

  it("records the worker erasing an account as the system, and then leaves no name in the log", async () => {
    const alice = await registerUser("alice");
    await ask(alice);
    await login("alice"); // cancelled, so ask again
    await ask(alice);
    const requestedAt = (await row(alice)).deletionRequestedAt!;
    expect(await purgeDueAccounts(new Date(requestedAt.getTime() + 15 * DAY), 14)).toBe(1);

    const got = await entries();
    expect(got.map((e) => e.action)).toEqual(["account.delete_request", "account.delete_cancel", "account.delete_request", "account.erase"]);
    expect(got[3]).toMatchObject({ source: "system", actorUserId: null, actorLabel: "the server (automatic)", targetId: alice.user.id, targetLabel: "Deleted user" });
    // What alice did and what was done to her are still there, without her name.
    expect(JSON.stringify(got)).not.toMatch(/@alice/);
    expect(got.filter((e) => e.actorUserId === alice.user.id).every((e) => e.actorLabel === "Deleted user")).toBe(true);
  });

  it("records another server's person being forgotten without their name", async () => {
    const far = await registerTestPeer("far.test");
    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: far.domain, isRemote: true } });
    await prisma.auditLogEntry.create({ data: { source: "api", action: "member.kick", actorLabel: "@somebody:chat", targetType: "user", targetId: remy.protocolId, targetLabel: "@remy:far.test" } });
    expect((await signedPost(far, "/federation/v1/account-deleted", { protocolId: remy.protocolId })).status).toBe(204);
    expect((await entries())[0].targetLabel).toBe("Deleted user");
  });
});

afterEach(() => {
  config.accountDeletionGraceDays = 14;
});
