// Download of a person's own data (#60): everything this server holds ABOUT them, nothing it holds about anyone else, and nothing
// secret. It needs the password again (a stolen access token must not be enough to take someone's whole history).
import { generate } from "otplib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { exportBatchSize, setExportBatchSizeForTests } from "../../src/modules/users/exportData.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";
type Registered = Awaited<ReturnType<typeof registerUser>>;

const requestExport = (user: Registered, body: object = { password: PASSWORD }) =>
  api.post("/api/v1/users/me/export").set(authHeader(user.accessToken)).send(body).buffer(true).parse((res, done) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => (text += chunk));
    res.on("end", () => done(null, text));
  });
const exported = async (user: Registered) => {
  const res = await requestExport(user);
  expect(res.status).toBe(200);
  return { res, text: res.body as string, data: JSON.parse(res.body as string) };
};

const createCommunity = async (owner: Registered, name = "Club") =>
  (await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name })).body.community as { id: string; channels: { id: string }[] };
const joinCommunity = (community: { id: string }, user: Registered) => api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken));
const dmWith = async (from: Registered, ...others: string[]) =>
  (await api.post("/api/v1/conversations").set(authHeader(from.accessToken)).send({ type: others.length > 1 ? "GROUP" : "DM", memberUsernames: others, title: others.length > 1 ? "Crew" : undefined })).body.conversation.id as string;
const say = (user: Registered, path: string, content: string) => api.post(path).set(authHeader(user.accessToken)).send({ content });

describe("asking for the export", () => {
  it("needs a signed-in person who knows their password", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    expect((await api.post("/api/v1/users/me/export").send({ password: PASSWORD })).status).toBe(401);
    const wrong = await requestExport(alice, { password: "Not-The-Password-1!" });
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body as string).error).toBe("invalid_credentials");
    expect((await requestExport(alice, {})).status).toBe(400);
  });

  it("comes as a file to save, which is not kept by anything on the way", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const { res } = await exported(alice);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="chat-export-alice-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers["cache-control"]).toContain("no-store");
  });
});

describe("what is in it", () => {
  it("is the account, as the person has it", async () => {
    const alice = await registerUser("alice", { password: PASSWORD, displayName: "Alice A" });
    await api.patch("/api/v1/users/me").set(authHeader(alice.accessToken)).send({ bio: "hello", pronouns: "she/her" });
    const { data } = await exported(alice);
    expect(data.format).toBe("federated-chat-export");
    expect(data.version).toBe(1);
    expect(data.server.domain).toBe(config.domain);
    expect(data.account).toMatchObject({ username: "alice", identity: `@alice:${config.domain}`, displayName: "Alice A", bio: "hello", pronouns: "she/her", twoFactorEnabled: false });
    expect(new Date(data.account.createdAt).getTime()).not.toBeNaN();
  });

  it("is the messages they sent, in chats and communities, and nobody else's", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const bob = await registerUser("bob");
    const club = await createCommunity(alice, "Alice's Club");
    await joinCommunity(club, bob);
    const channel = club.channels[0].id;
    const dm = await dmWith(alice, "bob");
    const group = await dmWith(alice, "bob");
    await say(alice, `/api/v1/channels/${channel}/messages`, "alice in the club");
    await say(bob, `/api/v1/channels/${channel}/messages`, "bob in the club");
    await say(alice, `/api/v1/conversations/${dm}/messages`, "alice to bob");
    await say(bob, `/api/v1/conversations/${dm}/messages`, "bob to alice");

    const { data, text } = await exported(alice);
    const contents = data.messages.map((m: { content: string }) => m.content).sort();
    expect(contents).toEqual(["alice in the club", "alice to bob"]);
    expect(text).not.toContain("bob in the club");
    expect(text).not.toContain("bob to alice");
    const inClub = data.messages.find((m: { content: string }) => m.content === "alice in the club");
    expect(inClub.where).toMatchObject({ communityId: club.id, communityName: "Alice's Club", channelId: channel, channelName: "general" });
    const inDm = data.messages.find((m: { content: string }) => m.content === "alice to bob");
    expect(inDm.where).toMatchObject({ conversationId: dm });
    expect(group).toBeTruthy();
  });

  it("leaves out a message they deleted: it is gone, and the export is not a way to get it back", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const club = await createCommunity(alice);
    const sent = await say(alice, `/api/v1/channels/${club.channels[0].id}/messages`, "regretted");
    await say(alice, `/api/v1/channels/${club.channels[0].id}/messages`, "kept");
    await api.delete(`/api/v1/messages/${sent.body.message.id}`).set(authHeader(alice.accessToken));
    const { data, text } = await exported(alice);
    expect(data.messages.map((m: { content: string }) => m.content)).toEqual(["kept"]);
    expect(text).not.toContain("regretted");
  });

  it("carries a message's files (as addresses to fetch them from), when it was edited, and what it replied to", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const club = await createCommunity(alice);
    const message = (await say(alice, `/api/v1/channels/${club.channels[0].id}/messages`, "with a file")).body.message;
    const row = await prisma.message.findUniqueOrThrow({ where: { protocolId: message.id } });
    await prisma.attachment.create({ data: { messageId: row.id, url: "/uploads/cat.png", filename: "cat.png", contentType: "image/png", size: 1234 } });
    await api.patch(`/api/v1/messages/${message.id}`).set(authHeader(alice.accessToken)).send({ content: "with a file, edited" });
    const { data } = await exported(alice);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].content).toBe("with a file, edited");
    expect(data.messages[0].editedAt).toBeTruthy();
    expect(data.messages[0].attachments).toEqual([{ url: `${config.baseUrl}/uploads/cat.png`, filename: "cat.png", contentType: "image/png", size: 1234 }]);
  });

  it("is every message even when there are many (it is written in batches), once each and oldest first", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const club = await createCommunity(alice);
    const original = exportBatchSize;
    setExportBatchSizeForTests(5);
    const total = exportBatchSize * 2 + 3;
    const row = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    const channel = await prisma.channel.findFirstOrThrow({ where: { community: { protocolId: club.id } } });
    const start = Date.now() - 1_000_000;
    await prisma.message.createMany({
      data: Array.from({ length: total }, (_, i) => ({ protocolId: newProtocolId(), channelId: channel.id, senderId: row.id, content: `m${i}`, createdAt: new Date(start + (i >> 1) * 1000) })),
    });
    const { data } = await exported(alice).finally(() => setExportBatchSizeForTests(original));
    const contents: string[] = data.messages.map((m: { content: string }) => m.content);
    expect(contents).toHaveLength(total);
    expect(new Set(contents).size).toBe(total);
    const times = data.messages.map((m: { createdAt: string }) => new Date(m.createdAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("is who they know: friends, what is waiting, and who they blocked, by address", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const dave = await registerUser("dave");
    await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "bob" });
    const incoming = (await api.get("/api/v1/friends/requests?direction=incoming").set(authHeader(bob.accessToken))).body;
    const requestId = (incoming.requests ?? incoming)[0]?.id;
    if (requestId) await api.post(`/api/v1/friends/requests/${requestId}/accept`).set(authHeader(bob.accessToken));
    await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "carol" });
    await api.post("/api/v1/friends/blocks").set(authHeader(alice.accessToken)).send({ username: "dave" });
    const { data } = await exported(alice);
    expect(data.friends.map((f: { identity: string }) => f.identity)).toContain(`@bob:${config.domain}`);
    expect(data.friendRequests.outgoing.map((f: { identity: string }) => f.identity)).toContain(`@carol:${config.domain}`);
    expect(data.blocked.map((f: { identity: string }) => f.identity)).toEqual([`@dave:${config.domain}`]);
    expect(dave && carol).toBeTruthy();
  });

  it("is their communities (and the roles they hold), their chats (and who is in them), their emoticons, their reactions and their notification choices", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const bob = await registerUser("bob");
    const club = await createCommunity(alice, "Alice's Club");
    await joinCommunity(club, bob);
    const dm = await dmWith(alice, "bob");
    const message = (await say(bob, `/api/v1/conversations/${dm}/messages`, "react to me")).body.message;
    await api.post(`/api/v1/messages/${message.id}/reactions`).set(authHeader(alice.accessToken)).send({ emoji: "👍" });
    await api.put("/api/v1/notification-settings").set(authHeader(alice.accessToken)).send({ type: "GLOBAL", sound: false });
    const row = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    await prisma.emoticon.create({ data: { protocolId: newProtocolId(), creatorId: row.id, name: "Wave", trigger: "wave", imageUrl: "/uploads/wave.png" } });

    const { data } = await exported(alice);
    expect(data.communities).toEqual([expect.objectContaining({ id: club.id, name: "Alice's Club", owner: true })]);
    expect(data.communities[0].roles.length).toBeGreaterThan(0);
    expect(data.conversations).toEqual([expect.objectContaining({ id: dm, type: "DM", members: expect.arrayContaining([`@alice:${config.domain}`, `@bob:${config.domain}`]) })]);
    expect(data.reactions).toEqual([expect.objectContaining({ messageId: message.id, emoji: "👍" })]);
    expect(data.emoticons.created).toEqual([expect.objectContaining({ name: "Wave", trigger: "wave", imageUrl: `${config.baseUrl}/uploads/wave.png` })]);
    expect(data.notificationSettings).toEqual([expect.objectContaining({ type: "GLOBAL", sound: false })]);
  });

  it("does not hold anything about a person on another server beyond how to name them", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const aliceRow = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", bio: "remote bio", homeserverDomain: "far.example", isRemote: true } });
    await prisma.friendship.createMany({ data: [{ userId: aliceRow.id, friendId: remy.id }, { userId: remy.id, friendId: aliceRow.id }] });
    const { data, text } = await exported(alice);
    expect(data.friends).toEqual([expect.objectContaining({ identity: "@remy:far.example", displayName: "Remy" })]);
    expect(text).not.toContain("remote bio");
  });
});

describe("what is never in it", () => {
  it("is any secret: no password hash, no 2FA secret or recovery code, no token", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(alice.accessToken)).send({ password: PASSWORD })).body;
    const verified = await api.post("/api/v1/auth/2fa/verify").set(authHeader(alice.accessToken)).send({ code: await generate({ secret }) });
    const row = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    const secrets = [row.passwordHash!, row.totpSecret!, alice.refreshToken, alice.accessToken, ...(verified.body.recoveryCodes as string[])];
    expect(secrets.every(Boolean)).toBe(true);

    const { data, text } = await exported(alice);
    for (const value of secrets) expect(text).not.toContain(value);
    expect(text).not.toMatch(/passwordHash|totpSecret|tokenHash|recoveryCode/i);
    expect(data.account.twoFactorEnabled).toBe(true);
  });

  it("is anything of someone else's account: another person's export is theirs alone", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const bob = await registerUser("bob", { displayName: "Bobby Tables", password: PASSWORD });
    const { text } = await exported(alice);
    expect(text).not.toContain("Bobby Tables");
    expect((await exported(bob)).data.account.username).toBe("bob");
  });
});
