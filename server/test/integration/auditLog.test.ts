// The audit log (#59), against the real app and database: every moderation action in a community is recorded with who did it, to what and
// where; what must NOT be recorded (a refused attempt, what anyone wrote); who may read it (the admin page: everything; a community's
// managers: their own community, and only that); and what happens to a person's name in it when their account is erased.
import { generate } from "otplib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { Permission } from "../../src/lib/permissions.js";
import { setAdmin } from "../../src/modules/admin/service.js";
import { ERASED_LABEL, OPERATOR, pruneAudit, recordAudit } from "../../src/modules/audit/service.js";
import { purgeAccount } from "../../src/modules/users/deletion.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";
type Registered = Awaited<ReturnType<typeof registerUser>>;
type Community = { id: string; name: string; channels: { id: string }[]; roles: { id: string; isDefault: boolean }[] };

const createCommunity = async (owner: Registered, name = "Club") =>
  (await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name })).body.community as Community;
const join = (community: Community, user: Registered) => api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken));
const as = (user: Registered) => authHeader(user.accessToken);
const rows = () => prisma.auditLogEntry.findMany({ orderBy: { id: "asc" } });
const last = async () => (await rows()).at(-1)!;

async function admin(username: string) {
  const user = await registerUser(username, { password: PASSWORD });
  await setAdmin(username, true);
  const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(as(user)).send({ password: PASSWORD })).body;
  await api.post("/api/v1/auth/2fa/verify").set(as(user)).send({ code: await generate({ secret }) });
  // Making them an admin is itself recorded (see the test for it); the tests that use this are about other entries.
  await prisma.auditLogEntry.deleteMany();
  return user;
}

describe("what a community's moderators do is recorded", () => {
  it("a kick, with who did it, to whom, and where", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice, "Alice's Club");
    await join(club, bob);

    expect((await api.delete(`/api/v1/communities/${club.id}/members/${bob.user.id}`).set(as(alice))).status).toBe(204);

    expect(await last()).toMatchObject({
      source: "api",
      action: "member.kick",
      actorUserId: alice.user.id,
      actorLabel: expect.stringMatching(/^@alice:/),
      communityId: club.id,
      communityLabel: "Alice's Club",
      targetType: "user",
      targetId: bob.user.id,
      targetLabel: expect.stringMatching(/^@bob:/),
    });
  });

  it("a ban and an unban, but never the reason a moderator gave", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice);
    await join(club, bob);

    await api.post(`/api/v1/communities/${club.id}/bans`).set(as(alice)).send({ protocolId: bob.user.id, reason: "he said something private about carol" });
    await api.delete(`/api/v1/communities/${club.id}/bans/${bob.user.id}`).set(as(alice));

    const [ban, unban] = (await rows()).slice(-2);
    expect(ban).toMatchObject({ action: "member.ban", targetId: bob.user.id, details: { hasReason: true } });
    expect(unban).toMatchObject({ action: "member.unban", targetId: bob.user.id });
    expect(JSON.stringify(await rows())).not.toContain("private about carol");
  });

  it("roles: made, changed (which fields and the permissions before and after), given, taken back, deleted", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice);
    await join(club, bob);

    const made = await api.post(`/api/v1/communities/${club.id}/roles`).set(as(alice)).send({ name: "Mods", permissions: String(Permission.KICK_MEMBERS) });
    const roleId = made.body.role.id as string;
    await api.patch(`/api/v1/communities/${club.id}/roles/${roleId}`).set(as(alice)).send({ name: "Moderators", permissions: String(Permission.KICK_MEMBERS | Permission.BAN_MEMBERS) });
    await api.post(`/api/v1/communities/${club.id}/members/${bob.user.id}/roles/${roleId}`).set(as(alice));
    await api.delete(`/api/v1/communities/${club.id}/members/${bob.user.id}/roles/${roleId}`).set(as(alice));
    await api.delete(`/api/v1/communities/${club.id}/roles/${roleId}`).set(as(alice));

    const entries = (await rows()).slice(-5);
    expect(entries.map((e) => e.action)).toEqual(["role.create", "role.update", "member.role.add", "member.role.remove", "role.delete"]);
    expect(entries[0]).toMatchObject({ targetType: "role", targetId: roleId, targetLabel: "Mods" });
    expect(entries[1].details).toEqual({
      fields: ["name", "permissions"],
      permissionsBefore: String(Permission.KICK_MEMBERS),
      permissionsAfter: String(Permission.KICK_MEMBERS | Permission.BAN_MEMBERS),
    });
    expect(entries[2]).toMatchObject({ targetType: "user", targetId: bob.user.id, details: { role: "Moderators" } });
    expect(entries[3]).toMatchObject({ targetId: bob.user.id, details: { role: "Moderators" } });
    expect(entries[4]).toMatchObject({ targetType: "role", targetLabel: "Moderators" });
  });

  it("channels: made, renamed, deleted", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice);
    const made = await api.post(`/api/v1/communities/${club.id}/channels`).set(as(alice)).send({ name: "random" });
    const channelId = made.body.channel.id as string;
    await api.patch(`/api/v1/communities/${club.id}/channels/${channelId}`).set(as(alice)).send({ name: "off-topic", topic: "anything" });
    await api.delete(`/api/v1/communities/${club.id}/channels/${channelId}`).set(as(alice));

    const entries = (await rows()).slice(-3);
    expect(entries.map((e) => e.action)).toEqual(["channel.create", "channel.update", "channel.delete"]);
    expect(entries[0]).toMatchObject({ targetType: "channel", targetId: channelId, targetLabel: "random", details: { type: "TEXT" } });
    expect(entries[1].details).toEqual({ fields: ["name", "topic"], newName: "off-topic" });
    // Said as it was when it was deleted, so the entry still reads.
    expect(entries[2]).toMatchObject({ targetLabel: "off-topic" });
  });

  it("the community's own settings: which fields changed, and the new name and who-can-join, never the description", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice, "Old Name");
    await api.patch(`/api/v1/communities/${club.id}`).set(as(alice)).send({ name: "New Name", description: "a private description", visibility: "INVITE_ONLY" });

    const entry = await last();
    expect(entry).toMatchObject({ action: "community.update", communityLabel: "Old Name", targetLabel: "Old Name" });
    expect(entry.details).toEqual({ fields: ["name", "description", "visibility"], newName: "New Name", visibility: "INVITE_ONLY" });
    expect(JSON.stringify(entry)).not.toContain("private description");
  });

  it("handing the community on, and deleting it, with the name as it was", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const bob = await registerUser("bob");
    const club = await createCommunity(alice, "Handover");
    await join(club, bob);
    expect((await api.put(`/api/v1/communities/${club.id}/owner`).set(as(alice)).send({ userId: bob.user.id, password: PASSWORD })).status).toBe(200);
    expect(await last()).toMatchObject({ action: "community.transfer", actorUserId: alice.user.id, targetId: bob.user.id, communityLabel: "Handover" });

    expect((await api.delete(`/api/v1/communities/${club.id}`).set(as(bob))).status).toBe(204);
    expect(await last()).toMatchObject({ action: "community.delete", actorUserId: bob.user.id, communityId: club.id, communityLabel: "Handover", targetType: "community" });
  });

  it("a moderator removing someone else's message: which and where, never what it said; and not someone removing their own", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice, "Chatty");
    await join(club, bob);
    const channel = club.channels[0].id;
    const theirs = (await api.post(`/api/v1/channels/${channel}/messages`).set(as(bob)).send({ content: "something embarrassing" })).body.message;
    const mine = (await api.post(`/api/v1/channels/${channel}/messages`).set(as(bob)).send({ content: "I will remove this myself" })).body.message;

    expect((await api.delete(`/api/v1/messages/${mine.id}`).set(as(bob))).status).toBe(204);
    expect(await rows()).toHaveLength(0);

    expect((await api.delete(`/api/v1/messages/${theirs.id}`).set(as(alice))).status).toBe(204);
    const entry = await last();
    expect(entry).toMatchObject({ action: "message.delete", actorUserId: alice.user.id, communityId: club.id, targetType: "message", targetId: theirs.id, details: { channel: "general" } });
    expect(JSON.stringify(entry)).not.toContain("embarrassing");
  });

  it("a person from another server removing someone's message, recorded as them", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice, "Federated");
    const far = await registerTestPeer("far.test");
    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: far.domain, isRemote: true } });
    const clubRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } });
    const member = await prisma.communityMember.create({ data: { communityId: clubRow.id, userId: remy.id } });
    const role = await prisma.role.create({ data: { communityId: clubRow.id, name: "Mods", permissions: Permission.DELETE_MESSAGES } });
    await prisma.memberRole.create({ data: { memberId: member.id, roleId: role.id } });
    const channel = await prisma.channel.findFirstOrThrow({ where: { communityId: clubRow.id } });
    const message = await prisma.message.create({ data: { protocolId: newProtocolId(), channelId: channel.id, senderId: (await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } })).id, content: "from alice" } });

    const res = await signedPost(far, `/federation/v1/communities/${club.id}/channels/${channel.protocolId}/messages/${message.protocolId}/delete`, { username: "remy" });
    expect(res.status).toBe(204);
    expect(await last()).toMatchObject({ action: "message.delete", actorUserId: remy.protocolId, actorLabel: "@remy:far.test", targetId: message.protocolId });
  });
});

describe("what is not recorded (another server)", () => {
  it("a person from another server removing their own message", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice, "Federated");
    const far = await registerTestPeer("far.test");
    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: far.domain, isRemote: true } });
    const clubRow = await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } });
    await prisma.communityMember.create({ data: { communityId: clubRow.id, userId: remy.id } });
    const channel = await prisma.channel.findFirstOrThrow({ where: { communityId: clubRow.id } });
    const own = await prisma.message.create({ data: { protocolId: newProtocolId(), channelId: channel.id, senderId: remy.id, content: "remy's own" } });

    const res = await signedPost(far, `/federation/v1/communities/${club.id}/channels/${channel.protocolId}/messages/${own.protocolId}/delete`, { username: "remy" });
    expect(res.status).toBe(204);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: own.id } })).deletedAt).not.toBeNull();
    expect(await rows()).toEqual([]);
  });
});

describe("what is not recorded", () => {
  it("an attempt that was refused, whoever made it", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(alice);
    await join(club, bob);
    await join(club, carol);

    expect((await api.delete(`/api/v1/communities/${club.id}/members/${carol.user.id}`).set(as(bob))).status).toBe(403);
    expect((await api.post(`/api/v1/communities/${club.id}/bans`).set(as(bob)).send({ protocolId: carol.user.id })).status).toBe(403);
    expect((await api.post(`/api/v1/communities/${club.id}/roles`).set(as(bob)).send({ name: "x" })).status).toBe(403);
    expect((await api.patch(`/api/v1/communities/${club.id}`).set(as(bob)).send({ name: "hijacked" })).status).toBe(403);
    expect((await api.delete(`/api/v1/communities/${club.id}`).set(as(bob))).status).toBe(403);
    expect((await api.delete(`/api/v1/communities/${club.id}/members/${alice.user.id}`).set(as(alice))).status).toBe(400); // the owner cannot be kicked
    expect(await rows()).toEqual([]);
  });

  it("ordinary use: joining, leaving, talking, editing your own words", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice);
    await join(club, bob);
    const msg = (await api.post(`/api/v1/channels/${club.channels[0].id}/messages`).set(as(bob)).send({ content: "hello" })).body.message;
    await api.patch(`/api/v1/messages/${msg.id}`).set(as(bob)).send({ content: "hello again" });
    await api.delete(`/api/v1/communities/${club.id}/members/me`).set(as(bob));
    expect(await rows()).toEqual([]);
  });

  it("anything of what people wrote, or any secret", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const bob = await registerUser("bob");
    const club = await createCommunity(alice, "Careful");
    await join(club, bob);
    await api.post(`/api/v1/channels/${club.channels[0].id}/messages`).set(as(bob)).send({ content: "UNIQUE-MESSAGE-TEXT" });
    await api.post(`/api/v1/communities/${club.id}/bans`).set(as(alice)).send({ protocolId: bob.user.id, reason: "UNIQUE-REASON-TEXT" });
    await api.put(`/api/v1/communities/${club.id}/owner`).set(as(alice)).send({ userId: bob.user.id, password: PASSWORD }).catch(() => null);
    const text = JSON.stringify(await rows());
    for (const secret of ["UNIQUE-MESSAGE-TEXT", "UNIQUE-REASON-TEXT", PASSWORD, alice.accessToken, alice.refreshToken]) expect(text).not.toContain(secret);
  });
});

describe("recording", () => {
  it("never fails what it records, and says so loudly", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.auditLogEntry, "create").mockRejectedValue(new Error("the table is gone"));
    await expect(recordAudit({ source: "cli", action: "user.suspend", actor: OPERATOR })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("[audit] could not record an entry:", expect.any(Error));

    // And an action whose record cannot be written still happens.
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice);
    await join(club, bob);
    expect((await api.delete(`/api/v1/communities/${club.id}/members/${bob.user.id}`).set(as(alice))).status).toBe(204);
    expect(await prisma.communityMember.count({ where: { user: { protocolId: bob.user.id } } })).toBe(0);
  });

  it("keeps details short and plain, and labels to one line", async () => {
    await recordAudit({
      source: "cli",
      action: "setting.change",
      actor: OPERATOR,
      target: { type: "setting", id: "x", label: "line one\nline two‮evil" },
      details: { long: "z".repeat(1000), nested: { no: true } as unknown as string, ok: 3 },
    });
    const entry = await last();
    expect(entry.targetLabel).toBe("line one line two evil");
    expect(entry.details).toEqual({ long: `${"z".repeat(199)}…`, ok: 3 });
  });

  it("describes the operator and the system without an account", async () => {
    await recordAudit({ source: "cli", action: "user.suspend", actor: OPERATOR });
    expect(await last()).toMatchObject({ actorUserId: null, actorLabel: "the operator (command line)", source: "cli" });
  });
});

describe("the admin page's view: everything, newest first", () => {
  async function setup() {
    const root = await admin("root");
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const one = await createCommunity(alice, "One");
    const two = await createCommunity(bob, "Two");
    const carol = await registerUser("carol");
    await join(one, carol);
    await join(two, carol);
    await api.delete(`/api/v1/communities/${one.id}/members/${carol.user.id}`).set(as(alice));
    await api.post(`/api/v1/communities/${two.id}/bans`).set(as(bob)).send({ protocolId: carol.user.id });
    await api.post(`/api/v1/communities/${one.id}/channels`).set(as(alice)).send({ name: "extra" });
    return { root, alice, bob, carol, one, two };
  }
  const list = (user: Registered, query = "") => api.get(`/api/v1/admin/audit-log${query}`).set(as(user));

  it("lists across every community, newest first, in the shape the reference describes", async () => {
    const { root, alice, one } = await setup();
    const res = await list(root);
    expect(res.status).toBe(200);
    // The sign-up of root's own 2FA etc is not in it: only what is recorded.
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(["channel.create", "member.ban", "member.kick"]);
    expect(res.body.entries[0]).toEqual({
      id: expect.any(Number),
      at: expect.any(String),
      source: "api",
      action: "channel.create",
      actor: { id: alice.user.id, label: expect.stringMatching(/^@alice:/) },
      community: { id: one.id, name: "One" },
      target: { type: "channel", id: expect.any(String), label: "extra" },
      details: { type: "TEXT" },
    });
    expect(res.body.next).toBeNull();
  });

  it("filters by action, source, community, who did it and what it was done to", async () => {
    const { root, alice, bob, carol, one } = await setup();
    await recordAudit({ source: "cli", action: "user.suspend", actor: OPERATOR, target: { type: "user", id: carol.user.id, label: "@carol" } });

    const ids = async (query: string) => (await list(root, query)).body.entries.map((e: { action: string }) => e.action);
    expect(await ids("?action=member.ban")).toEqual(["member.ban"]);
    expect(await ids("?source=cli")).toEqual(["user.suspend"]);
    expect(await ids(`?community=${one.id}`)).toEqual(["channel.create", "member.kick"]);
    expect(await ids(`?actor=${bob.user.id}`)).toEqual(["member.ban"]);
    expect(await ids(`?actor=${alice.user.id}&action=member.kick`)).toEqual(["member.kick"]);
    expect(await ids(`?target=${carol.user.id}`)).toEqual(["user.suspend", "member.ban", "member.kick"]);
    expect(await ids("?community=nope")).toEqual([]);
  });

  it("pages: a limit, and a cursor that gets the next page and ends", async () => {
    const { root } = await setup();
    const first = await list(root, "?limit=2");
    expect(first.body.entries).toHaveLength(2);
    expect(first.body.next).toBe(first.body.entries[1].id);
    const second = await list(root, `?limit=2&before=${first.body.next}`);
    expect(second.body.entries).toHaveLength(1);
    expect(second.body.next).toBeNull();
    const all = [...first.body.entries, ...second.body.entries].map((e: { id: number }) => e.id);
    expect(new Set(all).size).toBe(3);
    expect([...all].sort((a, b) => b - a)).toEqual(all);
  });

  it("refuses a query that is not one, rather than guessing", async () => {
    const { root } = await setup();
    for (const query of ["?action=not.an.action", "?source=magic", "?limit=0", "?limit=500", "?limit=abc", "?before=-1", "?before=1.5"]) {
      expect((await list(root, query)).status, query).toBe(400);
    }
  });

  it("is for admins only, and there is no way to change an entry through it", async () => {
    const { alice } = await setup();
    expect((await list(alice)).status).toBe(404);
    const root = await admin("root2");
    for (const method of ["post", "put", "patch", "delete"] as const) {
      expect((await api[method]("/api/v1/admin/audit-log").set(as(root)).send({})).status, method).toBe(404);
    }
  });
});

describe("a community's own view", () => {
  async function setup() {
    const owner = await registerUser("olive");
    const mod = await registerUser("max");
    const plain = await registerUser("pat");
    const other = await registerUser("otto");
    const club = await createCommunity(owner, "Mine");
    const elsewhere = await createCommunity(other, "Theirs");
    await join(club, mod);
    await join(club, plain);
    const role = await api.post(`/api/v1/communities/${club.id}/roles`).set(as(owner)).send({ name: "Managers", permissions: String(Permission.MANAGE_COMMUNITY) });
    await api.post(`/api/v1/communities/${club.id}/members/${mod.user.id}/roles/${role.body.role.id}`).set(as(owner));
    await api.post(`/api/v1/communities/${elsewhere.id}/channels`).set(as(other)).send({ name: "theirs-only" });
    return { owner, mod, plain, other, club, elsewhere };
  }
  const view = (community: Community, user: Registered, query = "") => api.get(`/api/v1/communities/${community.id}/audit-log${query}`).set(as(user));

  it("is for those who manage it, and shows only this community's entries", async () => {
    const { owner, mod, club } = await setup();
    for (const who of [owner, mod]) {
      const res = await view(club, who);
      expect(res.status).toBe(200);
      expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual(["member.role.add", "role.create"]);
      for (const entry of res.body.entries) expect(entry.community.id).toBe(club.id);
    }
    expect(JSON.stringify((await view(club, owner)).body)).not.toContain("theirs-only");
  });

  it("is refused to everyone else: a member without the permission, a stranger and another community's owner", async () => {
    const { plain, other, club } = await setup();
    expect((await view(club, plain)).status).toBe(403);
    // Not a member at all: the same answer as for a member without the permission, not a hint the community exists... it is a 403 either way.
    expect((await view(club, other)).status).toBe(403);
    expect((await api.get(`/api/v1/communities/${club.id}/audit-log`)).status).toBe(401);
  });

  it("takes only this community, whatever the query says", async () => {
    const { owner, club, elsewhere } = await setup();
    const res = await view(club, owner, `?community=${elsewhere.id}`);
    expect(res.status).toBe(200);
    for (const entry of res.body.entries) expect(entry.community.id).toBe(club.id);
  });

  it("filters by action, pages, and refuses a bad query", async () => {
    const { owner, club } = await setup();
    expect((await view(club, owner, "?action=role.create")).body.entries).toHaveLength(1);
    const first = await view(club, owner, "?limit=1");
    expect(first.body.entries).toHaveLength(1);
    expect(first.body.next).not.toBeNull();
    expect((await view(club, owner, `?limit=1&before=${first.body.next}`)).body.entries).toHaveLength(1);
    expect((await view(club, owner, "?action=nope")).status).toBe(400);
  });

  it("does not exist for a community that lives on another server, and for one that does not exist", async () => {
    const { owner } = await setup();
    const far = await registerTestPeer("far.test");
    const hostStub = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "host", displayName: "Host", homeserverDomain: far.domain, isRemote: true } });
    const remote = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far", ownerId: hostStub.id, homeserverDomain: far.domain, isRemote: true } });
    expect((await api.get(`/api/v1/communities/${remote.protocolId}/audit-log`).set(as(owner))).status).toBe(409);
    expect((await api.get("/api/v1/communities/nosuch/audit-log").set(as(owner))).status).toBe(404);
  });
});

describe("a person's name", () => {
  it("goes from the log when their account is erased, and what was done stays", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const club = await createCommunity(alice, "Club");
    await join(club, bob);
    await join(club, carol);
    await api.delete(`/api/v1/communities/${club.id}/members/${bob.user.id}`).set(as(alice)); // alice does something to bob
    await api.post(`/api/v1/communities/${club.id}/bans`).set(as(alice)).send({ protocolId: carol.user.id }); // and again, to carol
    const before = await rows();
    expect(before.some((e) => e.actorLabel.startsWith("@alice"))).toBe(true);

    // Alice no longer owns it once it is handed on; erase her.
    const aliceRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    await prisma.community.update({ where: { protocolId: club.id }, data: { ownerId: (await prisma.user.findUniqueOrThrow({ where: { protocolId: carol.user.id } })).id } });
    expect((await purgeAccount(aliceRow.id)).ok).toBe(true);

    const after = await rows();
    expect(after).toHaveLength(before.length);
    for (const entry of after.filter((e) => e.actorUserId === alice.user.id)) expect(entry.actorLabel).toBe(ERASED_LABEL);
    expect(JSON.stringify(after)).not.toMatch(/@alice/);
    // Other people's names are untouched.
    expect(after.find((e) => e.targetId === bob.user.id)?.targetLabel).toMatch(/^@bob:/);
  });

  it("goes when it is a person done to, too", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice);
    await join(club, bob);
    await api.delete(`/api/v1/communities/${club.id}/members/${bob.user.id}`).set(as(alice));
    expect((await last()).targetLabel).toMatch(/^@bob:/);
    expect((await purgeAccount((await prisma.user.findUniqueOrThrow({ where: { protocolId: bob.user.id } })).id)).ok).toBe(true);
    expect(await last()).toMatchObject({ action: "member.kick", targetId: bob.user.id, targetLabel: ERASED_LABEL });
  });
});

describe("retention", () => {
  const entry = (at: Date) => prisma.auditLogEntry.create({ data: { source: "cli", action: "user.suspend", actorLabel: "x", createdAt: at } });
  const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  it("deletes entries older than the period and keeps the rest", async () => {
    await entry(days(400));
    await entry(days(366));
    await entry(days(364));
    await entry(days(1));
    expect(await pruneAudit(365)).toBe(2);
    expect(await prisma.auditLogEntry.count()).toBe(2);
  });

  it("keeps everything when the period is 0", async () => {
    await entry(days(5000));
    expect(await pruneAudit(0)).toBe(0);
    expect(await prisma.auditLogEntry.count()).toBe(1);
  });
});

describe("making and removing admins", () => {
  it("is recorded as the operator's, about the person, and says nothing else", async () => {
    await registerUser("alice");
    await setAdmin("alice", true);
    await setAdmin("alice", true); // nothing changed, so nothing to record
    await setAdmin("alice", false);
    const entries = await rows();
    expect(entries.map((e) => e.action)).toEqual(["user.admin_grant", "user.admin_revoke"]);
    expect(entries[0]).toMatchObject({ source: "cli", actorUserId: null, actorLabel: "the operator (command line)", targetType: "user", targetLabel: expect.stringMatching(/^@alice:/) });
  });
});
