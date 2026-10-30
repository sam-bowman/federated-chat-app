// Content reports (#58, docs/content-reports.md), against the real app and database. Each rule in the design note has a test here that fails
// without it: who a report reaches, what is kept and for how long, that the person reported is never told, who sees who reported, the limits
// that stop a report being a weapon, what reviewing does and records, and what erasure and deleting a community do to reports.
import { generate } from "otplib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { Permission } from "../../src/lib/permissions.js";
import { MAX_ATTACHMENTS, MAX_MESSAGE_TEXT } from "../../src/lib/reports.js";
import { setAdmin } from "../../src/modules/admin/service.js";
import { ERASED_LABEL } from "../../src/modules/audit/service.js";
import { pruneReports, reportContext } from "../../src/modules/reports/service.js";
import { purgeAccount } from "../../src/modules/users/deletion.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";
type Registered = Awaited<ReturnType<typeof registerUser>>;
type Community = { id: string; name: string; channels: { id: string }[] };

const as = (user: Registered) => authHeader(user.accessToken);
const createCommunity = async (owner: Registered, name = "Club") =>
  (await api.post("/api/v1/communities").set(as(owner)).send({ name })).body.community as Community;
const join = (community: Community, user: Registered) => api.post(`/api/v1/communities/${community.id}/members`).set(as(user));
const say = async (user: Registered, community: Community, content: string) =>
  (await api.post(`/api/v1/channels/${community.channels[0].id}/messages`).set(as(user)).send({ content })).body.message.id as string;
const openChat = async (from: Registered, ...others: string[]) =>
  (await api.post("/api/v1/conversations").set(as(from)).send({ type: others.length > 1 ? "GROUP" : "DM", memberUsernames: others, title: others.length > 1 ? "Crew" : undefined })).body.conversation.id as string;
const sayInChat = async (user: Registered, chat: string, content: string) =>
  (await api.post(`/api/v1/conversations/${chat}/messages`).set(as(user)).send({ content })).body.message.id as string;

const report = (user: Registered, kind: "message" | "user" | "community", id: string, extra: object = {}) =>
  api.post("/api/v1/reports").set(as(user)).send({ kind, id, reason: "spam", ...extra });
const rows = () => prisma.report.findMany({ orderBy: { id: "asc" } });
const only = async () => {
  const all = await rows();
  expect(all).toHaveLength(1);
  return all[0];
};

/** A role holding REVIEW_REPORTS (and nothing else), given to `user`. */
async function makeReviewer(owner: Registered, community: Community, user: Registered) {
  const made = await api.post(`/api/v1/communities/${community.id}/roles`).set(as(owner)).send({ name: "Reviewers", permissions: String(Permission.REVIEW_REPORTS) });
  expect(made.status).toBe(201);
  const given = await api.post(`/api/v1/communities/${community.id}/members/${user.user.id}/roles/${made.body.role.id}`).set(as(owner));
  expect(given.status).toBeLessThan(300);
}

async function admin(username: string) {
  const user = await registerUser(username, { password: PASSWORD });
  await setAdmin(username, true);
  const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(as(user)).send({ password: PASSWORD })).body;
  await api.post("/api/v1/auth/2fa/verify").set(as(user)).send({ code: await generate({ secret }) });
  await prisma.auditLogEntry.deleteMany();
  return user;
}

const queue = (community: Community, user: Registered, query = "") => api.get(`/api/v1/communities/${community.id}/reports${query}`).set(as(user));
const adminQueue = (user: Registered, query = "") => api.get(`/api/v1/admin/reports${query}`).set(as(user));

/** A community hosted on another server: this server only has a copy, with a local member and a message by a remote person. */
async function remoteCommunity(member: Registered) {
  const owner = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "host", displayName: "Host", homeserverDomain: "far.test", isRemote: true } });
  const community = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far", ownerId: owner.id, homeserverDomain: "far.test", isRemote: true } });
  const channel = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: community.id, name: "general" } });
  const me = await prisma.user.findUniqueOrThrow({ where: { protocolId: member.user.id } });
  await prisma.communityMember.create({ data: { communityId: community.id, userId: me.id } });
  const message = await prisma.message.create({ data: { protocolId: newProtocolId(), channelId: channel.id, senderId: owner.id, content: "from far away" } });
  return { community, message };
}

describe("making a report", () => {
  it("a message in a community channel goes to that community, with what was said as it was said", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(alice, "Alice's Club");
    await join(club, bob);
    await join(club, carol);
    const id = await say(bob, club, "buy my pills");

    const res = await report(carol, "message", id, { reason: "spam", details: "  he does this every day  " });

    expect(res.status).toBe(201);
    // It says that it was received and nothing else: no id, no state.
    expect(res.body).toEqual({ received: true });
    expect(await only()).toMatchObject({
      kind: "MESSAGE",
      scope: "COMMUNITY",
      status: "OPEN",
      reason: "spam",
      details: "he does this every day",
      reporterId: carol.user.id,
      targetId: id,
      targetUserId: bob.user.id,
      snapshot: { type: "message", text: "buy my pills", where: { community: "Alice's Club", channel: "general" }, sender: { identity: expect.stringMatching(/^@bob:/) } },
    });
  });

  it("keeps what was reported even after it is edited or deleted", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice);
    await join(club, bob);
    const id = await say(bob, club, "the original words");
    await report(alice, "message", id);

    await api.patch(`/api/v1/messages/${id}`).set(as(bob)).send({ content: "something innocent" });
    expect((await api.delete(`/api/v1/messages/${id}`).set(as(bob))).status).toBeLessThan(300);

    expect((await only()).snapshot).toMatchObject({ text: "the original words" });
  });

  it("limits the snapshot: text cut, at most five attachment addresses, and nothing that can hide or reorder text", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice);
    await join(club, bob);
    const id = await say(bob, club, `${"x".repeat(MAX_MESSAGE_TEXT + 500)}`);
    const message = await prisma.message.findUniqueOrThrow({ where: { protocolId: id } });
    for (let i = 0; i < MAX_ATTACHMENTS + 3; i++) {
      await prisma.attachment.create({ data: { messageId: message.id, url: `/uploads/${i}.png`, filename: `${i}.png`, contentType: "image/png", size: 1 } });
    }
    await prisma.message.update({ where: { id: message.id }, data: { content: `safe‮text​ hidden\n${"y".repeat(MAX_MESSAGE_TEXT + 10)}` } });

    await report(alice, "message", id);

    const snapshot = (await only()).snapshot as { text: string; attachments: string[]; attachmentCount: number };
    expect([...snapshot.text].length).toBeLessThanOrEqual(MAX_MESSAGE_TEXT);
    expect(snapshot.text).not.toMatch(/[‮​]/u);
    expect(snapshot.text.startsWith("safetext hidden\n")).toBe(true);
    expect(snapshot.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(snapshot.attachmentCount).toBe(MAX_ATTACHMENTS + 3);
  });

  it("a direct or group message goes to the server's admins alone, shows only that message, and is not marked with the conversation's members", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const direct = await openChat(alice, "bob");
    await sayInChat(alice, direct, "before");
    const said = await sayInChat(bob, direct, "the nasty one");
    await sayInChat(alice, direct, "after");
    const group = await openChat(alice, "bob", "carol");
    const inGroup = await sayInChat(carol, group, "in the group");

    expect((await report(alice, "message", said)).status).toBe(201);
    expect((await report(alice, "message", inGroup)).status).toBe(201);

    const all = await rows();
    expect(all.map((r) => r.scope)).toEqual(["SERVER", "SERVER"]);
    expect(all.every((r) => r.communityId === null)).toBe(true);
    expect(all[0].snapshot).toMatchObject({ text: "the nasty one", where: { conversation: "direct" } });
    expect(all[1].snapshot).toMatchObject({ where: { conversation: "group" } });
    // Nothing around it came along.
    expect(JSON.stringify(all[0].snapshot)).not.toMatch(/before|after/u);
  });

  it("a person, and a community, go to the admins alone", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await prisma.user.update({ where: { protocolId: bob.user.id }, data: { bio: "my bio", pronouns: "he/him", customStatus: "around" } });
    const club = await createCommunity(alice, "Alice's Club");
    await join(club, bob);

    expect((await report(alice, "user", bob.user.id, { reason: "impersonation" })).status).toBe(201);
    expect((await report(bob, "community", club.id, { reason: "illegal" })).status).toBe(201);

    const [byUser, byCommunity] = await rows();
    expect(byUser).toMatchObject({ kind: "USER", scope: "SERVER", communityId: null, targetUserId: bob.user.id, snapshot: { type: "user", bio: "my bio", pronouns: "he/him", customStatus: "around" } });
    expect(byCommunity).toMatchObject({ kind: "COMMUNITY", scope: "SERVER", snapshot: { type: "community", name: "Alice's Club" } });
  });

  it("only what you can see can be reported, and everything else looks like something that does not exist", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const stranger = await registerUser("stranger");
    const club = await createCommunity(alice);
    await join(club, bob);
    const inClub = await say(bob, club, "members only");
    const chat = await openChat(alice, "bob");
    const inChat = await sayInChat(alice, chat, "just us");
    const deleted = await say(bob, club, "gone");
    await api.delete(`/api/v1/messages/${deleted}`).set(as(bob));
    await api.post("/api/v1/friends/blocks").set(as(bob)).send({ username: "stranger" });

    const missing = await report(stranger, "message", newProtocolId());
    expect(missing.status).toBe(404);
    for (const attempt of [
      () => report(stranger, "message", inClub),
      () => report(stranger, "message", inChat),
      () => report(alice, "message", deleted),
      () => report(stranger, "community", club.id),
      () => report(stranger, "user", bob.user.id), // bob blocked them
      () => report(stranger, "user", newProtocolId()),
    ]) {
      const res = await attempt();
      expect(res.status).toBe(404);
      expect(res.body).toEqual(missing.body);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("not your own message, person or community", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice);
    const own = await say(alice, club, "mine");

    for (const res of [await report(alice, "message", own), await report(alice, "user", alice.user.id), await report(alice, "community", club.id)]) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "cannot_report_self" });
    }
    expect(await rows()).toHaveLength(0);
  });

  it("the same thing once per person, even when two requests arrive together", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(alice);
    await join(club, bob);
    await join(club, carol);
    const id = await say(bob, club, "once");

    const twice = await Promise.all([report(carol, "message", id), report(carol, "message", id)]);
    expect(twice.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(twice.find((r) => r.status === 409)!.body).toEqual({ error: "already_reported" });
    // Someone else may still report it, and the same person may report something else.
    expect((await report(alice, "message", id)).status).toBe(201);
    expect((await report(carol, "user", bob.user.id)).status).toBe(201);
    expect(await rows()).toHaveLength(3);
  });

  it("a person who made many reports in the last hour, or has many open, is told to wait", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(alice);
    await join(club, bob);
    await join(club, carol);
    const id = await say(bob, club, "one more");
    const filler = (n: number, createdAt: Date, status: "OPEN" | "RESOLVED") =>
      prisma.report.createMany({
        data: Array.from({ length: n }, (_, i) => ({ protocolId: newProtocolId(), kind: "USER" as const, scope: "SERVER" as const, status, reason: "spam", reporterId: carol.user.id, reporterLabel: "@carol", targetKey: `user:${newProtocolId()}`, targetId: `t${i}`, snapshot: {}, createdAt })),
      });

    await filler(9, new Date(), "RESOLVED");
    expect((await report(carol, "message", id)).status).toBe(201); // the tenth
    const eleventh = await report(carol, "user", bob.user.id);
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual({ error: "too_many_reports" });

    // Old ones do not count against the hour, closed ones do not count as open, and 30 open ones do.
    await prisma.report.deleteMany();
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await filler(29, longAgo, "OPEN");
    await filler(5, longAgo, "RESOLVED");
    expect((await report(carol, "message", id)).status).toBe(201);
    expect((await report(carol, "user", bob.user.id)).status).toBe(429);
    // The limit is per person.
    expect((await report(alice, "message", id)).status).toBe(201);
  });

  it("needs a signed-in person and a well-formed request", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    expect((await api.post("/api/v1/reports").send({ kind: "user", id: bob.user.id, reason: "spam" })).status).toBe(401);
    for (const body of [
      { kind: "thing", id: bob.user.id, reason: "spam" },
      { kind: "user", id: bob.user.id, reason: "rude" },
      { kind: "user", id: "", reason: "spam" },
      { kind: "user", id: bob.user.id, reason: "spam", details: "x".repeat(501) },
      { kind: "user", reason: "spam" },
    ]) {
      expect((await api.post("/api/v1/reports").set(as(alice)).send(body)).status).toBe(400);
    }
    expect(await rows()).toHaveLength(0);
  });
});

describe("the person reported is never told", () => {
  it("no event is sent to anyone, they cannot read the queue, and nothing is written to the audit log", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(alice);
    await join(club, bob);
    await join(club, carol);
    const id = await say(bob, club, "something rude");
    const events = await prisma.syncEvent.count();
    const audits = await prisma.auditLogEntry.count();

    await report(carol, "message", id);
    await report(carol, "user", bob.user.id);

    expect(await prisma.syncEvent.count()).toBe(events);
    expect(await prisma.auditLogEntry.count()).toBe(audits);
    expect((await queue(club, bob)).status).toBe(403);
    // Nothing they can read about the message or themself mentions it.
    const seen = JSON.stringify([
      (await api.get(`/api/v1/channels/${club.channels[0].id}/messages`).set(as(bob))).body,
      (await api.get("/api/v1/users/me").set(as(bob))).body,
      (await api.get(`/api/v1/users/${bob.user.id}/profile`).set(as(bob))).body,
    ]);
    expect(seen).not.toMatch(/report/iu);
  });
});

describe("a community's queue", () => {
  async function setup() {
    const owner = await registerUser("owner");
    const mod = await registerUser("mod");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(owner, "Club");
    for (const u of [mod, bob, carol]) await join(club, u);
    await makeReviewer(owner, club, mod);
    return { owner, mod, bob, carol, club };
  }

  it("is read by whoever holds Review reports, and the owner; no other permission, and no other community's owner, will do", async () => {
    const { owner, mod, bob, carol, club } = await setup();
    const id = await say(bob, club, "bad");
    await report(carol, "message", id);
    const other = await createCommunity(carol, "Other");
    // A role with every other permission but not this one.
    const everythingElse = Object.values(Permission).filter((p) => p !== Permission.REVIEW_REPORTS).reduce((a, b) => a | b, 0n);
    const role = await api.post(`/api/v1/communities/${club.id}/roles`).set(as(owner)).send({ name: "Everything else", permissions: String(everythingElse) });
    await api.post(`/api/v1/communities/${club.id}/members/${bob.user.id}/roles/${role.body.role.id}`).set(as(owner));

    expect((await queue(club, owner)).body.reports).toHaveLength(1);
    expect((await queue(club, mod)).body.reports).toHaveLength(1);
    expect((await queue(club, carol)).status).toBe(403); // an ordinary member
    expect((await queue(club, bob)).status).toBe(403); // every other permission
    expect((await queue(other, carol)).body.reports).toHaveLength(0); // an owner, but of another community
    expect((await api.get(`/api/v1/communities/${club.id}/reports`)).status).toBe(401);
  });

  it("holds only what was reported in it: not a report about the community itself, not a direct message, not another community's", async () => {
    const { owner, mod, bob, carol, club } = await setup();
    const other = await createCommunity(owner, "Other");
    await join(other, bob);
    await report(carol, "message", await say(bob, club, "here"));
    await report(carol, "community", club.id);
    await report(carol, "user", bob.user.id);
    await report(bob, "message", await say(owner, other, "elsewhere"));
    const chat = await openChat(bob, "carol");
    await report(carol, "message", await sayInChat(bob, chat, "private"));

    const listed = (await queue(club, mod)).body.reports as { kind: string; snapshot: { text: string } }[];
    expect(listed.map((r) => r.snapshot.text)).toEqual(["here"]);
    expect(listed.every((r) => r.kind === "message")).toBe(true);

    // Ids from other queues do not open here either, whichever way they are mixed.
    const aboutClub = await prisma.report.findFirstOrThrow({ where: { kind: "COMMUNITY" } });
    const elsewhere = await prisma.report.findFirstOrThrow({ where: { targetUserId: owner.user.id } });
    for (const r of [aboutClub, elsewhere]) {
      expect((await api.get(`/api/v1/communities/${club.id}/reports/${r.protocolId}`).set(as(mod))).status).toBe(404);
      expect((await api.post(`/api/v1/communities/${club.id}/reports/${r.protocolId}/dismiss`).set(as(mod)).send({})).status).toBe(404);
    }
    expect((await prisma.report.findUniqueOrThrow({ where: { id: aboutClub.id } })).status).toBe("OPEN");
  });

  it("shows the reporter, and how many reports they made here and how many were dismissed, counting this community only", async () => {
    const { owner, mod, bob, carol, club } = await setup();
    const first = await say(bob, club, "one");
    const second = await say(bob, club, "two");
    const third = await say(bob, club, "three");
    await report(carol, "message", first);
    await report(carol, "message", second);
    await report(carol, "message", third);
    const other = await createCommunity(owner, "Other");
    await join(other, bob);
    await join(other, carol);
    await report(carol, "message", await say(bob, other, "elsewhere"));
    const mine = (await queue(club, mod)).body.reports as { id: string; reporter: { id: string; label: string } }[];
    await api.post(`/api/v1/communities/${club.id}/reports/${mine[0].id}/dismiss`).set(as(mod)).send({});

    const res = await queue(club, mod);

    expect(res.body.reports[0].reporter).toEqual({ id: carol.user.id, label: expect.stringMatching(/^@carol:/), history: { total: 3, dismissed: 1 } });
  });

  it("is never shown to the person reported, even when they are a reviewer themselves", async () => {
    const { owner, mod, bob, carol, club } = await setup();
    await report(carol, "message", await say(mod, club, "a moderator said it"));
    await report(carol, "message", await say(bob, club, "a member said it"));
    const aboutMod = await prisma.report.findFirstOrThrow({ where: { targetUserId: mod.user.id } });

    const seenByMod = await queue(club, mod);
    expect(seenByMod.body.reports.map((r: { target: { userId: string } }) => r.target.userId)).toEqual([bob.user.id]);
    expect(seenByMod.body.open).toBe(1);
    expect((await api.get(`/api/v1/communities/${club.id}/reports/${aboutMod.protocolId}`).set(as(mod))).status).toBe(404);
    expect((await api.post(`/api/v1/communities/${club.id}/reports/${aboutMod.protocolId}/dismiss`).set(as(mod)).send({})).status).toBe(404);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: aboutMod.id } })).status).toBe("OPEN");
    // The owner is not the one reported, so they see both.
    expect((await queue(club, owner)).body.reports).toHaveLength(2);
  });

  it("answers 404 for a community that does not exist and 409 for a copy of one hosted elsewhere", async () => {
    const alice = await registerUser("alice");
    const far = await remoteCommunity(alice);
    expect((await api.get(`/api/v1/communities/${newProtocolId()}/reports`).set(as(alice))).status).toBe(404);
    const res = await api.get(`/api/v1/communities/${far.community.protocolId}/reports`).set(as(alice));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "remote_community_management_not_supported" });
  });

  it("pages newest first, can be narrowed by state, and says how many are open", async () => {
    const { mod, bob, carol, club } = await setup();
    const ids = [];
    for (const text of ["a", "b", "c"]) {
      const id = await say(bob, club, text);
      ids.push(id);
      await report(carol, "message", id);
    }
    const page = await queue(club, mod, "?limit=2");
    expect(page.body.reports.map((r: { snapshot: { text: string } }) => r.snapshot.text)).toEqual(["c", "b"]);
    expect(page.body.next).toEqual(expect.any(Number));
    const rest = await queue(club, mod, `?limit=2&before=${page.body.next}`);
    expect(rest.body.reports.map((r: { snapshot: { text: string } }) => r.snapshot.text)).toEqual(["a"]);
    expect(rest.body.next).toBeNull();

    await api.post(`/api/v1/communities/${club.id}/reports/${page.body.reports[0].id}/dismiss`).set(as(mod)).send({});
    expect((await queue(club, mod, "?status=open")).body.reports).toHaveLength(2);
    expect((await queue(club, mod, "?status=dismissed")).body.reports).toHaveLength(1);
    expect((await queue(club, mod)).body.open).toBe(2);
    expect((await queue(club, mod, "?status=bogus")).status).toBe(400);
    expect((await queue(club, mod, "?limit=1000")).status).toBe(400);
  });
});

describe("reviewing a report", () => {
  async function setup() {
    const owner = await registerUser("owner");
    const mod = await registerUser("mod");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(owner, "Club");
    for (const u of [mod, bob, carol]) await join(club, u);
    await makeReviewer(owner, club, mod);
    await report(carol, "message", await say(bob, club, "bad words"), { details: "please look" });
    const reportId = (await queue(club, mod)).body.reports[0].id as string;
    const base = `/api/v1/communities/${club.id}/reports/${reportId}`;
    return { owner, mod, bob, carol, club, reportId, base };
  }

  it("resolves with what was done and a note, and says who and when", async () => {
    const { mod, base } = await setup();

    const res = await api.post(`${base}/resolve`).set(as(mod)).send({ action: "message_deleted", note: "  removed it  " });

    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({ status: "resolved", resolution: { by: expect.stringMatching(/^@mod:/), action: "message_deleted", note: "removed it", at: expect.any(String) } });
    expect((await api.get(base).set(as(mod))).body.report.status).toBe("resolved");
  });

  it("dismisses, and can reopen a closed report, which clears how it was closed", async () => {
    const { mod, base } = await setup();
    const dismissed = await api.post(`${base}/dismiss`).set(as(mod)).send({ note: "fine" });
    expect(dismissed.body.report).toMatchObject({ status: "dismissed", resolution: { action: null, note: "fine" } });

    const reopened = await api.post(`${base}/reopen`).set(as(mod)).send({});

    expect(reopened.body.report).toMatchObject({ status: "open", resolution: null });
    const row = await only();
    expect(row).toMatchObject({ status: "OPEN", resolvedAt: null, resolvedById: null, resolvedByLabel: null, action: null, note: null });
  });

  it("refuses closing what is not open and reopening what is not closed, and a resolve needs an action from the list", async () => {
    const { mod, base } = await setup();
    expect((await api.post(`${base}/reopen`).set(as(mod)).send({})).body).toEqual({ error: "not_closed" });
    expect((await api.post(`${base}/resolve`).set(as(mod)).send({})).status).toBe(400);
    expect((await api.post(`${base}/resolve`).set(as(mod)).send({ action: "delete_everything" })).status).toBe(400);
    expect((await api.post(`${base}/resolve`).set(as(mod)).send({ action: "none", note: "x".repeat(501) })).status).toBe(400);
    expect((await api.post(`${base}/resolve`).set(as(mod)).send({ action: "none" })).status).toBe(200);
    for (const verb of ["resolve", "dismiss"]) {
      const again = await api.post(`${base}/${verb}`).set(as(mod)).send({ action: "none" });
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ error: "not_open" });
    }
  });

  it("two reviewers closing it at once: one closes it, the other is told, and only one entry is written", async () => {
    const { owner, mod, base } = await setup();
    const both = await Promise.all([api.post(`${base}/dismiss`).set(as(mod)).send({}), api.post(`${base}/resolve`).set(as(owner)).send({ action: "none" })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.auditLogEntry.count({ where: { action: { startsWith: "report." } } })).toBe(1);
  });

  it("needs the permission, and an ordinary member cannot close anything", async () => {
    const { carol, base } = await setup();
    for (const verb of ["resolve", "dismiss", "reopen"]) {
      expect((await api.post(`${base}/${verb}`).set(as(carol)).send({ action: "none" })).status).toBe(403);
    }
    expect((await api.get(base).set(as(carol))).status).toBe(403);
    expect((await only()).status).toBe("OPEN");
  });

  it("records each action in the community's audit log by id and kind, and never what was said", async () => {
    const { owner, mod, club, reportId, base } = await setup();
    await api.post(`${base}/resolve`).set(as(mod)).send({ action: "member_kicked", note: "a private note about carol" });
    await api.post(`${base}/reopen`).set(as(mod)).send({});
    await api.post(`${base}/dismiss`).set(as(mod)).send({ note: "another private note" });

    const entries = await prisma.auditLogEntry.findMany({ where: { action: { startsWith: "report." } }, orderBy: { id: "asc" } });

    expect(entries.map((e) => e.action)).toEqual(["report.resolve", "report.reopen", "report.dismiss"]);
    expect(entries[0]).toMatchObject({ source: "api", actorUserId: mod.user.id, communityId: club.id, targetType: "report", targetId: reportId, targetLabel: "message", details: { kind: "message", action: "member_kicked" } });
    const written = JSON.stringify(entries);
    expect(written).not.toMatch(/bad words|please look|private note|carol/iu);
    // And the community's managers can read it there.
    const log = await api.get(`/api/v1/communities/${club.id}/audit-log`).set(as(owner));
    expect(log.body.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["report.resolve", "report.reopen", "report.dismiss"]));
  });

  it("a refused attempt writes nothing", async () => {
    const { carol, base } = await setup();
    await api.post(`${base}/dismiss`).set(as(carol)).send({});
    expect(await prisma.auditLogEntry.count({ where: { action: { startsWith: "report." } } })).toBe(0);
  });
});

describe("the admins' queue", () => {
  it("is invisible to anyone who is not an admin, and an admin needs two-factor sign-in", async () => {
    const alice = await registerUser("alice");
    const owner = await registerUser("owner");
    const club = await createCommunity(owner);
    const noTwoFactor = await registerUser("boss", { password: PASSWORD });
    await setAdmin("boss", true);

    for (const res of [await adminQueue(alice), await api.get("/api/v1/admin/reports")]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    }
    expect((await adminQueue(noTwoFactor)).status).toBe(403);
    expect((await api.post("/api/v1/admin/reports/x/dismiss").set(as(alice)).send({})).status).toBe(404);
  });

  it("holds everything that reaches this server: direct messages, people and communities as well as a community's messages", async () => {
    const root = await admin("root");
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(owner, "Club");
    await join(club, bob);
    await join(club, carol);
    const chat = await openChat(bob, "carol");
    await report(carol, "message", await say(bob, club, "in the community"));
    await report(carol, "message", await sayInChat(bob, chat, "in a direct message"));
    await report(carol, "user", bob.user.id);
    await report(carol, "community", club.id);

    const res = await adminQueue(root);

    expect(res.body.reports.map((r: { kind: string; scope: string }) => `${r.kind}/${r.scope}`).sort()).toEqual(["community/server", "message/community", "message/server", "user/server"]);
    expect(res.body.open).toBe(4);
    expect((await adminQueue(root, "?scope=community")).body.reports).toHaveLength(1);
    expect((await adminQueue(root, "?scope=server")).body.reports).toHaveLength(3);
    // A community report names the community, so the admin can open it; the reporter's history here is across everything.
    const aboutClub = res.body.reports.find((r: { kind: string }) => r.kind === "community");
    expect(aboutClub.communityId).toBe(club.id);
    expect(aboutClub.reporter.history).toEqual({ total: 4, dismissed: 0 });
  });

  it("closes and reopens with the two-factor sign-in alone (no sudo mode), recorded as the admin's, and the log of a community that was itself reported learns nothing", async () => {
    const root = await admin("root");
    const owner = await registerUser("owner");
    const carol = await registerUser("carol");
    const club = await createCommunity(owner, "Club");
    await join(club, carol);
    await report(carol, "community", club.id, { reason: "illegal" });
    const id = (await adminQueue(root)).body.reports[0].id as string;

    const resolved = await api.post(`/api/v1/admin/reports/${id}/resolve`).set(as(root)).send({ action: "community_changed" });
    const reopened = await api.post(`/api/v1/admin/reports/${id}/reopen`).set(as(root)).send({});
    const dismissed = await api.post(`/api/v1/admin/reports/${id}/dismiss`).set(as(root)).send({});

    expect([resolved.status, reopened.status, dismissed.status]).toEqual([200, 200, 200]);
    expect((await api.get(`/api/v1/admin/reports/${id}`).set(as(root))).body.report.status).toBe("dismissed");
    const entries = await prisma.auditLogEntry.findMany({ where: { action: { startsWith: "report." } }, orderBy: { id: "asc" } });
    expect(entries.map((e) => [e.source, e.action, e.actorUserId])).toEqual([
      ["admin", "report.resolve", root.user.id],
      ["admin", "report.reopen", root.user.id],
      ["admin", "report.dismiss", root.user.id],
    ]);
    // Not in the community's own log: its owner is the one reported.
    expect(entries.every((e) => e.communityId === null)).toBe(true);
    const log = await api.get(`/api/v1/communities/${club.id}/audit-log`).set(as(owner));
    expect(JSON.stringify(log.body)).not.toMatch(/report/iu);
  });

  it("an admin who is the person reported does not see it", async () => {
    const root = await admin("root");
    const carol = await registerUser("carol");
    await report(carol, "user", root.user.id);
    expect((await adminQueue(root)).body.reports).toHaveLength(0);
    const row = await only();
    expect((await api.get(`/api/v1/admin/reports/${row.protocolId}`).set(as(root))).status).toBe(404);
  });
});

describe("erasure, retention and deleting a community", () => {
  it("when the person reported is erased, what they wrote goes from the snapshot and their name from the report, but the report stays", async () => {
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(owner);
    await join(club, bob);
    await join(club, carol);
    await report(carol, "message", await say(bob, club, "something awful"));
    await report(carol, "user", bob.user.id);
    const bobRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: bob.user.id } });

    expect(await purgeAccount(bobRow.id)).toEqual({ ok: true });

    const all = await rows();
    expect(all).toHaveLength(2);
    for (const r of all) {
      expect(r).toMatchObject({ status: "OPEN", reason: "spam", snapshot: { type: "erased" }, targetLabel: ERASED_LABEL });
      expect(JSON.stringify(r)).not.toMatch(/something awful|bob/iu);
    }
    const listed = (await queue(club, owner)).body.reports;
    expect(listed).toHaveLength(1);
    expect(listed[0].snapshot).toEqual({ type: "erased" });
  });

  it("when the reporter is erased, the report stays but no longer says who made it", async () => {
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(owner);
    await join(club, bob);
    await join(club, carol);
    await report(carol, "message", await say(bob, club, "kept"));
    const carolRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: carol.user.id } });

    expect(await purgeAccount(carolRow.id)).toEqual({ ok: true });

    const row = await only();
    expect(row).toMatchObject({ reporterId: null, reporterLabel: ERASED_LABEL, snapshot: { text: "kept" } });
    expect(JSON.stringify(row)).not.toMatch(/carol/iu);
    expect((await queue(club, owner)).body.reports[0].reporter).toEqual({ id: null, label: ERASED_LABEL, history: null });
  });

  it("when a reviewer is erased, the report no longer names them", async () => {
    const owner = await registerUser("owner");
    const mod = await registerUser("mod");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(owner);
    for (const u of [mod, bob, carol]) await join(club, u);
    await makeReviewer(owner, club, mod);
    await report(carol, "message", await say(bob, club, "x"));
    const id = (await queue(club, mod)).body.reports[0].id;
    await api.post(`/api/v1/communities/${club.id}/reports/${id}/dismiss`).set(as(mod)).send({});

    await purgeAccount((await prisma.user.findUniqueOrThrow({ where: { protocolId: mod.user.id } })).id);

    expect((await only()).resolvedByLabel).toBe(ERASED_LABEL);
  });

  it("deleting a community deletes its reports", async () => {
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(owner);
    await join(club, bob);
    await join(club, carol);
    await report(carol, "message", await say(bob, club, "x"));
    await report(carol, "community", club.id);
    await report(carol, "user", bob.user.id);

    await api.delete(`/api/v1/communities/${club.id}`).set(as(owner)).send({ password: PASSWORD });

    // The two that were about the community or in it; the one about a person is not.
    expect((await rows()).map((r) => r.kind)).toEqual(["USER"]);
  });

  it("old reports are deleted whatever state they are in, and 0 keeps everything", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const day = 24 * 60 * 60 * 1000;
    const make = (status: "OPEN" | "RESOLVED" | "DISMISSED", ageDays: number) =>
      prisma.report.create({ data: { protocolId: newProtocolId(), kind: "USER", scope: "SERVER", status, reason: "spam", reporterId: alice.user.id, reporterLabel: "@alice", targetKey: `user:${newProtocolId()}`, targetId: bob.user.id, snapshot: {}, createdAt: new Date(Date.now() - ageDays * day) } });
    await make("OPEN", 200);
    await make("RESOLVED", 181);
    await make("DISMISSED", 400);
    const young = await make("OPEN", 179);

    expect(await pruneReports(0)).toBe(0);
    expect(await rows()).toHaveLength(4);
    expect(await pruneReports(180)).toBe(3);

    expect((await rows()).map((r) => r.id)).toEqual([young.id]);
  });
});

describe("the count of reports waiting", () => {
  const count = (community: Community, user: Registered) => api.get(`/api/v1/communities/${community.id}/reports/open-count`).set(as(user));
  const adminCount = (user: Registered) => api.get("/api/v1/admin/reports/open-count").set(as(user));

  async function setup() {
    const owner = await registerUser("owner");
    const mod = await registerUser("mod");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(owner, "Club");
    for (const u of [mod, bob, carol]) await join(club, u);
    await makeReviewer(owner, club, mod);
    return { owner, mod, bob, carol, club };
  }

  it("is the number the queue itself calls open, and goes down when a report is closed and up when it is reopened", async () => {
    const { owner, mod, bob, carol, club } = await setup();
    expect((await count(club, mod)).body).toEqual({ open: 0 });
    await report(carol, "message", await say(bob, club, "one"));
    await report(carol, "message", await say(bob, club, "two"));
    expect((await count(club, mod)).body).toEqual({ open: 2 });
    expect((await count(club, owner)).body).toEqual({ open: 2 });
    expect((await queue(club, mod, "?limit=1")).body.open).toBe(2);

    const [first] = (await queue(club, mod)).body.reports as { id: string }[];
    await api.post(`/api/v1/communities/${club.id}/reports/${first.id}/dismiss`).set(as(mod)).send({});
    expect((await count(club, mod)).body).toEqual({ open: 1 });
    await api.post(`/api/v1/communities/${club.id}/reports/${first.id}/reopen`).set(as(mod)).send({});
    expect((await count(club, mod)).body).toEqual({ open: 2 });
  });

  it("is for the community's reviewers only, and is the community's own", async () => {
    const { owner, mod, bob, carol, club } = await setup();
    await report(carol, "message", await say(bob, club, "bad"));
    const other = await createCommunity(carol, "Other");
    expect((await count(club, carol)).status).toBe(403); // an ordinary member
    expect((await count(club, bob)).status).toBe(403);
    expect((await api.get(`/api/v1/communities/${club.id}/reports/open-count`)).status).toBe(401);
    expect((await count(other, carol)).body).toEqual({ open: 0 }); // an owner, but of another community
    expect((await count(club, owner)).body).toEqual({ open: 1 });
    expect((await count(club, mod)).body).toEqual({ open: 1 });
  });

  it("counts only what the reviewer could open: not a report about themself, not one about the community or a person, not a direct message", async () => {
    const { owner, mod, bob, carol, club } = await setup();
    await report(carol, "message", await say(owner, club, "the owner's own words"));
    await report(carol, "message", await say(mod, club, "the moderator's own words"));
    await report(carol, "community", club.id);
    await report(carol, "user", bob.user.id);
    const chat = await openChat(bob, "carol");
    await report(carol, "message", await sayInChat(bob, chat, "private"));
    await report(carol, "message", await say(bob, club, "the one that counts"));

    expect((await count(club, owner)).body).toEqual({ open: 2 }); // not the one about their own words
    expect((await count(club, mod)).body).toEqual({ open: 2 }); // nor this one
    expect((await count(club, owner)).body.open).toBe((await queue(club, owner)).body.open);
    expect((await count(club, mod)).body.open).toBe((await queue(club, mod)).body.open);
  });

  it("is the admins' own for the admins: everything that reaches the server, nothing about themself, and not the record of a report carried elsewhere", async () => {
    const root = await admin("root");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const owner = await registerUser("owner");
    const club = await createCommunity(owner, "Club");
    await join(club, bob);
    await join(club, carol);
    await report(carol, "message", await say(bob, club, "in the community"));
    await report(carol, "user", bob.user.id);
    await report(carol, "community", club.id);
    await report(bob, "user", root.user.id); // about the admin
    await prisma.report.create({
      data: { protocolId: newProtocolId(), kind: "MESSAGE", scope: "REMOTE", reason: "spam", reporterId: carol.user.id, reporterLabel: "@carol", targetKey: `message:${newProtocolId()}`, targetId: newProtocolId(), snapshot: {} },
    });

    expect((await adminCount(root)).body).toEqual({ open: 3 });
    expect((await adminCount(root)).body.open).toBe((await adminQueue(root)).body.open);
    expect((await adminCount(carol)).status).toBe(404); // not an admin
    expect((await api.get("/api/v1/admin/reports/open-count")).status).toBe(404);
  });

  it("is not audited, and tells no one anything", async () => {
    const { mod, bob, carol, club } = await setup();
    await report(carol, "message", await say(bob, club, "bad"));
    const before = await prisma.auditLogEntry.count();
    await count(club, mod);
    expect(await prisma.auditLogEntry.count()).toBe(before);
  });
});

describe("the messages around a reported one", () => {
  const context = (community: Community, user: Registered, reportId: string) =>
    api.get(`/api/v1/communities/${community.id}/reports/${reportId}/context`).set(as(user));

  async function setup() {
    const owner = await registerUser("owner");
    const mod = await registerUser("mod");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(owner, "Club");
    for (const u of [mod, bob, carol]) await join(club, u);
    await makeReviewer(owner, club, mod);
    return { owner, mod, bob, carol, club };
  }

  /** Twelve messages, the reported one in the middle (seventh), spaced a second apart so their order is settled. */
  async function conversation(club: Community, bob: Registered, carol: Registered) {
    const ids: string[] = [];
    for (let n = 1; n <= 13; n++) {
      ids.push(await say(n === 7 ? bob : carol, club, n === 7 ? "the reported one" : `line ${n}`));
      await prisma.message.update({ where: { protocolId: ids[n - 1] }, data: { createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, n)) } });
    }
    await report(carol, "message", ids[6]);
    const found = await prisma.report.findFirstOrThrow();
    return { ids, reportId: found.protocolId };
  }

  it("shows five either side, in order, with the reported one marked", async () => {
    const { mod, bob, carol, club } = await setup();
    const { ids, reportId } = await conversation(club, bob, carol);

    const res = await context(club, mod, reportId);
    expect(res.status).toBe(200);
    expect(res.body.context.state).toBe("same");
    expect(res.body.context.channel).toBe("general");
    const shown = res.body.context.messages as { id: string; text: string; reported: boolean; sender: { identity: string } }[];
    expect(shown.map((m) => m.id)).toEqual(ids.slice(1, 12)); // 2..12: five before, the message, five after
    expect(shown.map((m) => m.reported)).toEqual([false, false, false, false, false, true, false, false, false, false, false]);
    expect(shown[5].text).toBe("the reported one");
    expect(shown[5].sender.identity).toBe("@bob:test.local");
  });

  it("shows only text: no reactions, pictures or link previews, and long messages cut short", async () => {
    const { mod, bob, carol, club } = await setup();
    const long = await say(carol, club, "x".repeat(1900));
    const id = await say(bob, club, "https://example.com/ look");
    await report(carol, "message", id);
    const reportId = (await prisma.report.findFirstOrThrow()).protocolId;

    const shown = (await context(club, mod, reportId)).body.context.messages as Record<string, unknown>[];
    expect(shown.find((m) => m.id === long)!.text).toHaveLength(500);
    for (const m of shown) expect(Object.keys(m).sort()).toEqual(["at", "attachmentCount", "id", "reported", "sender", "text"]);
  });

  it("says when the message was edited since, deleted since, or is gone, and shows nothing it should not", async () => {
    const { mod, bob, carol, club } = await setup();
    const { ids, reportId } = await conversation(club, bob, carol);

    expect((await api.patch(`/api/v1/messages/${ids[6]}`).set(as(bob)).send({ content: "something else now" })).status).toBe(200);
    const edited = (await context(club, mod, reportId)).body.context;
    expect(edited.state).toBe("edited");
    expect(edited.messages.find((m: { reported: boolean }) => m.reported).text).toBe("something else now");

    await api.delete(`/api/v1/messages/${ids[6]}`).set(as(bob));
    await api.delete(`/api/v1/messages/${ids[8]}`).set(as(carol));
    const deleted = (await context(club, mod, reportId)).body.context;
    expect(deleted.state).toBe("deleted");
    const byId = new Map<string, { text: string | null }>(deleted.messages.map((m: { id: string; text: string | null }) => [m.id, m]));
    expect(byId.get(ids[6])!.text).toBeNull();
    expect(byId.get(ids[8])!.text).toBeNull(); // another message deleted since: also gone from view
    expect(byId.get(ids[9])!.text).toBe("line 10");

    await prisma.message.deleteMany({ where: { protocolId: ids[6] } });
    expect((await context(club, mod, reportId)).body.context).toEqual({ state: "gone", channel: null, messages: [] });
  });

  it("is the community's reviewers' alone: not a member, not another community's owner, not the person it is about, and never the admins", async () => {
    const { owner, mod, bob, carol, club } = await setup();
    const { reportId } = await conversation(club, bob, carol);
    const other = await createCommunity(carol, "Other");
    const root = await admin("root");

    expect((await context(club, owner, reportId)).status).toBe(200);
    expect((await context(club, carol, reportId)).status).toBe(403); // an ordinary member
    expect((await context(club, bob, reportId)).status).toBe(403);
    expect((await context(other, carol, reportId)).status).toBe(404); // an owner, but of another community: not this report
    expect((await api.get(`/api/v1/communities/${club.id}/reports/${reportId}/context`)).status).toBe(401);
    // The admins' queue has no such route at all.
    expect((await api.get(`/api/v1/admin/reports/${reportId}/context`).set(as(root))).status).toBe(404);

    // The person the report is about, who is also a reviewer, is not shown it (nor who reported them).
    await makeReviewer(owner, club, bob);
    expect((await context(club, bob, reportId)).status).toBe(404);
    expect((await context(club, mod, reportId)).status).toBe(200);
  });

  it("is not for a report about a direct message, a person or a community, and has nothing for a report that is not found", async () => {
    const { mod, bob, carol, club } = await setup();
    const chat = await openChat(bob, "carol");
    await report(carol, "message", await sayInChat(bob, chat, "private"));
    await report(carol, "user", bob.user.id);
    await report(carol, "community", club.id);
    for (const r of await rows()) expect((await context(club, mod, r.protocolId)).status).toBe(404);
    expect((await context(club, mod, "nonsense")).status).toBe(404);
  });

  it("stays in the reported message's channel and community", async () => {
    const { owner, mod, bob, carol, club } = await setup();
    const side = (await api.post(`/api/v1/communities/${club.id}/channels`).set(as(owner)).send({ name: "side" })).body.channel as { id: string };
    await api.post(`/api/v1/channels/${side.id}/messages`).set(as(carol)).send({ content: "in another channel, before" });
    const id = await say(bob, club, "the reported one");
    await api.post(`/api/v1/channels/${side.id}/messages`).set(as(carol)).send({ content: "in another channel, after" });
    await report(carol, "message", id);
    const reportId = (await prisma.report.findFirstOrThrow()).protocolId;

    const texts = ((await context(club, mod, reportId)).body.context.messages as { text: string }[]).map((m) => m.text);
    expect(texts).toEqual(["the reported one"]);

    // A message that is no longer in this community (its channel was moved): nothing is shown.
    const other = await createCommunity(carol, "Other");
    const otherRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: other.id } });
    await prisma.channel.update({ where: { protocolId: club.channels[0].id }, data: { communityId: otherRow.id } });
    expect((await context(club, mod, reportId)).body.context.state).toBe("gone");
  });

  it("counts attachments without showing them, and none for a message deleted since", async () => {
    const { mod, bob, carol, club } = await setup();
    const withFiles = await say(carol, club, "see attached");
    const row = await prisma.message.findUniqueOrThrow({ where: { protocolId: withFiles } });
    await prisma.attachment.createMany({
      data: [1, 2].map((n) => ({ messageId: row.id, url: `/uploads/${n}.png`, filename: `${n}.png`, contentType: "image/png", size: 10 })),
    });
    const id = await say(bob, club, "the reported one");
    await report(carol, "message", id);
    const reportId = (await prisma.report.findFirstOrThrow()).protocolId;

    const find = async () => ((await context(club, mod, reportId)).body.context.messages as { id: string; attachmentCount: number }[]).find((m) => m.id === withFiles)!;
    expect((await find()).attachmentCount).toBe(2);
    await api.delete(`/api/v1/messages/${withFiles}`).set(as(carol));
    expect((await find()).attachmentCount).toBe(0);
  });

  it("is never answered for the admins' scope, whatever is asked of the service", async () => {
    const { mod, bob, carol, club } = await setup();
    const { reportId } = await conversation(club, bob, carol);
    const reviewer = { protocolId: mod.user.id, username: "mod", homeserverDomain: "test.local" };
    expect(await reportContext({ type: "admin" }, reviewer, reportId)).toBeNull();
    expect(await reportContext({ type: "community", communityId: (await prisma.community.findFirstOrThrow()).id }, reviewer, reportId)).not.toBeNull();
  });

  it("is not audited, and does not change the report", async () => {
    const { mod, bob, carol, club } = await setup();
    const { reportId } = await conversation(club, bob, carol);
    const before = await prisma.auditLogEntry.count();
    const report0 = await prisma.report.findFirstOrThrow();
    await context(club, mod, reportId);
    expect(await prisma.auditLogEntry.count()).toBe(before);
    expect(await prisma.report.findFirstOrThrow()).toEqual(report0);
  });
});
