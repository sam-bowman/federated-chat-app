// The communities section of the admin page's API (#206): which communities this server hosts, what an admin may see of them, and the two things an
// admin can do, which both need sudo mode: hand one to a member, and delete one. What matters most is what it refuses (a stranger, a missing proof, a copy
// of another server's community, a new owner who cannot be one), that what it does is what the owner doing it would do (everyone told, files gone), and that
// nothing anyone wrote is in any answer or in the audit log.
import jwt from "jsonwebtoken";
import { generate } from "otplib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { listCommunitiesPage, setAdmin, suspendUser } from "../../src/modules/admin/service.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterEach(() => {
  config.adminEnabled = true;
});
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";
type Registered = Awaited<ReturnType<typeof registerUser>>;
interface Admin extends Registered {
  secret: string;
}

async function makeAdmin(username: string): Promise<Admin> {
  const user = await registerUser(username, { password: PASSWORD });
  await setAdmin(username, true);
  const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(user.accessToken)).send({ password: PASSWORD })).body;
  expect((await api.post("/api/v1/auth/2fa/verify").set(authHeader(user.accessToken)).send({ code: await generate({ secret }) })).status).toBe(200);
  await prisma.auditLogEntry.deleteMany();
  return { ...user, secret };
}
async function sudoOf(admin: Admin): Promise<string> {
  await prisma.user.update({ where: { protocolId: admin.user.id }, data: { totpLastUsedStep: null } });
  const res = await api.post("/api/v1/admin/sudo").set(authHeader(admin.accessToken)).send({ password: PASSWORD, code: await generate({ secret: admin.secret }) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.sudoToken as string;
}
const get = (path: string, as: Registered) => api.get(`/api/v1/admin${path}`).set(authHeader(as.accessToken));
const send = (method: "put" | "post", path: string, as: Registered, sudo?: string, body: object = {}) => {
  const request = api[method](`/api/v1/admin${path}`).set(authHeader(as.accessToken));
  if (sudo) request.set("X-Admin-Sudo", sudo);
  return request.send(body);
};
const entries = () => prisma.auditLogEntry.findMany({ orderBy: { id: "asc" } });

async function createCommunity(owner: Registered, name: string, description?: string): Promise<{ id: string; channels: { id: string }[] }> {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name, description });
  expect(res.status).toBe(201);
  return res.body.community;
}
const join = async (community: { id: string }, user: Registered) =>
  expect((await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken))).status).toBe(201);
const rowOf = (user: Registered) => prisma.user.findUniqueOrThrow({ where: { protocolId: user.user.id } });
const ownerOf = async (community: { id: string }) => (await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id }, include: { owner: true } })).owner.username;

async function addRemoteMember(community: { id: string }, domain: string, username = "remy") {
  const remote = await prisma.user.create({ data: { protocolId: newProtocolId(), username, displayName: username, homeserverDomain: domain, isRemote: true } });
  const row = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
  await prisma.communityMember.create({ data: { communityId: row.id, userId: remote.id } });
  return remote;
}
async function cachedCommunity(name = "Far Club", domain = "far.example") {
  const far = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "farowner", displayName: "Far", homeserverDomain: domain, isRemote: true } });
  return prisma.community.create({ data: { protocolId: newProtocolId(), name, ownerId: far.id, homeserverDomain: domain, isRemote: true } });
}

describe("who can reach it", () => {
  it("is not there for anyone who is not an admin", async () => {
    const bob = await registerUser("bob", { password: PASSWORD });
    const club = await createCommunity(bob, "Club");
    expect((await get("/communities", bob)).status).toBe(404);
    expect((await get(`/communities/${club.id}`, bob)).status).toBe(404);
    expect((await send("put", `/communities/${club.id}/owner`, bob, "x", { username: "bob" })).status).toBe(404);
    expect((await send("post", `/communities/${club.id}/delete`, bob, "x", { confirm: "Club" })).status).toBe(404);
    expect((await api.get("/api/v1/admin/communities")).status).toBe(404);
    expect(await prisma.community.count()).toBe(1);
  });

  it("needs two-factor sign-in to look", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    await setAdmin("alice", true);
    for (const path of ["/communities", `/communities/${newProtocolId()}`]) {
      const res = await get(path, alice);
      expect({ path, status: res.status, error: res.body.error }).toEqual({ path, status: 403, error: "admin_requires_two_factor" });
    }
  });

  it("needs sudo mode to hand one on or delete one, and a token of another kind or admin does not count", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const club = await createCommunity(alice, "Club");
    await join(club, bob);
    const bobAdmin = await makeAdmin("carol");
    const others = [undefined, "garbage", jwt.sign({ sub: alice.user.id }, config.jwtAccessSecret, { expiresIn: 600 }), await sudoOf(bobAdmin)];
    for (const token of others) {
      expect((await send("put", `/communities/${club.id}/owner`, alice, token, { username: "bob" })).body.error).toBe("sudo_required");
      expect((await send("post", `/communities/${club.id}/delete`, alice, token, { confirm: "Club" })).body.error).toBe("sudo_required");
    }
    expect(await ownerOf(club)).toBe("alice");
    expect(await prisma.community.count({ where: { protocolId: club.id } })).toBe(1);
    expect(await entries()).toHaveLength(0);
  });
});

describe("the list", () => {
  it("shows the communities this server hosts, oldest first, with who owns them and how big they are, and not a copy of another server's", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const first = await createCommunity(bob, "First");
    const second = await createCommunity(alice, "Second");
    await join(second, bob);
    await cachedCommunity();

    const res = await get("/communities", alice);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.communities.map((c: { id: string }) => c.id)).toEqual([first.id, second.id]);
    expect(res.body.communities[1]).toMatchObject({ name: "Second", owner: `@alice:${config.domain}`, members: 2 });
    expect(res.body.communities[0].channels).toBeGreaterThanOrEqual(1);
    expect(Object.keys(res.body.communities[0]).sort()).toEqual(["channels", "createdAt", "id", "members", "name", "owner", "visibility"]);
  });

  it("finds by part of the name, in any case, taking % and _ literally", async () => {
    const alice = await makeAdmin("alice");
    await createCommunity(alice, "Book Club");
    await createCommunity(alice, "Chess");
    await createCommunity(alice, "100% Gaming");
    const names = async (q: string) => (await get(`/communities?search=${encodeURIComponent(q)}`, alice)).body.communities.map((c: { name: string }) => c.name);
    expect(await names("book")).toEqual(["Book Club"]);
    expect(await names("  CHE  ")).toEqual(["Chess"]);
    expect(await names("%")).toEqual(["100% Gaming"]);
    expect(await names("_")).toEqual([]);
    expect(await names("nothing")).toEqual([]);
    expect((await get(`/communities?search=${encodeURIComponent("%")}`, alice)).body.total).toBe(1);
  });

  it("never answers with more than 100 at once, whoever asks (the service itself, not only the route's check)", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const owner = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    await prisma.community.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({ protocolId: newProtocolId(), name: `Club ${i}`, ownerId: owner.id, homeserverDomain: config.domain })),
    });
    const page = await listCommunitiesPage({ limit: 1000 });
    expect(page.communities).toHaveLength(100);
    expect(page.total).toBe(101);
    expect((await listCommunitiesPage({ limit: 0 })).communities).toHaveLength(25); // not a page of one, or of everything
    expect((await listCommunitiesPage({ limit: -3 })).communities).toHaveLength(25);
  });

  it("pages, with a total, and refuses a page it does not understand", async () => {
    const alice = await makeAdmin("alice");
    for (const name of ["A", "B", "C"]) await createCommunity(alice, name);
    const page = await get("/communities?limit=2&offset=1", alice);
    expect(page.body.communities.map((c: { name: string }) => c.name)).toEqual(["B", "C"]);
    expect(page.body.total).toBe(3);
    expect((await get("/communities?limit=1", alice)).body.communities).toHaveLength(1);
    for (const bad of ["limit=0", "limit=101", "limit=x", "offset=-1", `search=${"x".repeat(101)}`]) {
      expect((await get(`/communities?${bad}`, alice)).status, bad).toBe(400);
    }
  });
});

describe("one community", () => {
  it("says how big it is and where its members are from, and nothing anyone wrote in it", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const club = await createCommunity(bob, "Club", "A very private description");
    await join(club, alice);
    await addRemoteMember(club, "far.example", "remy");
    await addRemoteMember(club, "other.example", "otto");
    await api.post(`/api/v1/channels/${club.channels[0].id}/messages`).set(authHeader(bob.accessToken)).send({ content: "a secret message" });
    await api.post(`/api/v1/communities/${club.id}/channels`).set(authHeader(bob.accessToken)).send({ name: "secret-channel-name" });

    const res = await get(`/communities/${club.id}`, alice);
    expect(res.status).toBe(200);
    expect(res.body.community).toMatchObject({
      id: club.id,
      name: "Club",
      owner: `@bob:${config.domain}`,
      members: 4,
      localMembers: 2,
      remoteMembers: 2,
      remoteDomains: ["far.example", "other.example"],
      textChannels: 2,
      voiceChannels: 0,
    });
    expect(Object.keys(res.body.community).sort()).toEqual(
      ["channels", "createdAt", "id", "localMembers", "members", "name", "owner", "remoteDomains", "remoteMembers", "textChannels", "visibility", "voiceChannels"].sort()
    );
    const everything = JSON.stringify(res.body);
    for (const secret of ["private description", "secret message", "secret-channel-name"]) expect(everything).not.toContain(secret);
  });

  it("is a 404 for one that is not there and for a copy of another server's", async () => {
    const alice = await makeAdmin("alice");
    const cached = await cachedCommunity();
    expect((await get(`/communities/${newProtocolId()}`, alice)).status).toBe(404);
    expect((await get(`/communities/${cached.protocolId}`, alice)).status).toBe(404);
  });
});

describe("handing one to a member", () => {
  it("makes them the owner, tells every member's client and the other servers, and records it as the admin's from the page", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const carol = await registerUser("carol", { password: PASSWORD });
    const club = await createCommunity(bob, "Club");
    await join(club, carol);
    await join(club, alice);
    await addRemoteMember(club, "far.example");
    await prisma.syncEvent.deleteMany({ where: { type: "community:updated" } });
    await prisma.federationOutboxEvent.deleteMany();

    const res = await send("put", `/communities/${club.id}/owner`, alice, await sudoOf(alice), { username: "carol" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.community.owner).toBe(`@carol:${config.domain}`);
    expect(await ownerOf(club)).toBe("carol");
    // The old owner is still a member, and nothing else about them changed.
    expect(await prisma.communityMember.count({ where: { community: { protocolId: club.id }, userId: (await rowOf(bob)).id } })).toBe(1);

    const told = await prisma.syncEvent.findMany({ where: { type: "community:updated" } });
    expect(told.map((e) => e.recipientId).sort()).toEqual([(await rowOf(alice)).id, (await rowOf(bob)).id, (await rowOf(carol)).id].sort());
    const pings = await prisma.federationOutboxEvent.findMany({ where: { path: `/communities/${club.id}/updated` } });
    expect(pings.map((p) => p.domain)).toEqual(["far.example"]);

    const log = await entries();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: "community.transfer",
      source: "admin",
      actorUserId: alice.user.id,
      communityId: club.id,
      communityLabel: "Club",
      targetType: "user",
      targetId: carol.user.id,
      targetLabel: `@carol:${config.domain}`,
    });
  });

  it("takes the username in any case with spaces around it", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const carol = await registerUser("carol", { password: PASSWORD });
    const club = await createCommunity(bob, "Club");
    await join(club, carol);
    expect((await send("put", `/communities/${club.id}/owner`, alice, await sudoOf(alice), { username: "  CaRoL " })).status).toBe(200);
    expect(await ownerOf(club)).toBe("carol");
  });

  it("works when the owner is an account that is being closed, which cannot be deleted while it owns one", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const carol = await registerUser("carol", { password: PASSWORD });
    const club = await createCommunity(bob, "Club");
    await join(club, carol);
    const sudo = await sudoOf(alice);
    expect((await send("post", "/users/bob/delete", alice, sudo)).body.error).toBe("owns_communities");
    expect((await send("put", `/communities/${club.id}/owner`, alice, sudo, { username: "carol" })).status).toBe(200);
    expect((await send("post", "/users/bob/delete", alice, sudo)).status).toBe(200);
  });

  it("refuses what cannot be done, says why, and changes and records nothing", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const carol = await registerUser("carol", { password: PASSWORD });
    const dave = await registerUser("dave", { password: PASSWORD });
    const club = await createCommunity(bob, "Club");
    await join(club, carol);
    await join(club, dave);
    await suspendUser("dave");
    await addRemoteMember(club, "far.example", "remy");
    const cached = await cachedCommunity();
    await prisma.auditLogEntry.deleteMany();
    const sudo = await sudoOf(alice);
    const to = (id: string, body: object) => send("put", `/communities/${id}/owner`, alice, sudo, body);

    const cases: [string, string, object, number, string][] = [
      ["unknown community", newProtocolId(), { username: "carol" }, 404, "not_found"],
      ["a copy of another server's", cached.protocolId, { username: "carol" }, 409, "not_hosted_here"],
      ["no such person", club.id, { username: "nobody" }, 404, "user_not_found"],
      ["a person on another server", club.id, { username: "remy" }, 404, "user_not_found"],
      ["not a member", club.id, { username: "alice" }, 404, "not_a_member"],
      ["already the owner", club.id, { username: "bob" }, 400, "already_owner"],
      ["suspended", club.id, { username: "dave" }, 409, "target_suspended"],
      ["no username", club.id, {}, 400, "invalid_request"],
      ["an empty username", club.id, { username: "   " }, 400, "invalid_request"],
      ["a username that is not text", club.id, { username: 5 }, 400, "invalid_request"],
    ];
    for (const [what, id, body, status, error] of cases) {
      const res = await to(id, body);
      expect({ what, status: res.status, error: res.body.error }).toEqual({ what, status, error });
    }
    expect(await ownerOf(club)).toBe("bob");
    expect(await entries()).toHaveLength(0);
  });

  it("does not let two at once both win", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const carol = await registerUser("carol", { password: PASSWORD });
    const dave = await registerUser("dave", { password: PASSWORD });
    const club = await createCommunity(bob, "Club");
    await join(club, carol);
    await join(club, dave);
    const sudo = await sudoOf(alice);
    await prisma.auditLogEntry.deleteMany();
    const results = await Promise.all([
      send("put", `/communities/${club.id}/owner`, alice, sudo, { username: "carol" }),
      send("put", `/communities/${club.id}/owner`, alice, sudo, { username: "dave" }),
    ]);
    // Each reads the owner as bob and only moves it from bob, so exactly one moves it and the other is told the owner changed.
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe("ownership_changed");
    expect(await entries()).toHaveLength(1);
  });
});

describe("deleting one", () => {
  it("needs its name typed out, in any case, and deletes it as the owner would: members told, other servers pinged, recorded", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const carol = await registerUser("carol", { password: PASSWORD });
    const club = await createCommunity(bob, "Book Club");
    await join(club, carol);
    await addRemoteMember(club, "far.example");
    await api.post(`/api/v1/channels/${club.channels[0].id}/messages`).set(authHeader(carol.accessToken)).send({ content: "hello" });
    await prisma.auditLogEntry.deleteMany();
    await prisma.federationOutboxEvent.deleteMany();
    const sudo = await sudoOf(alice);

    for (const body of [{}, { confirm: "" }, { confirm: "Club" }, { confirm: "Book Clu" }, { confirm: "Book Club!" }]) {
      const res = await send("post", `/communities/${club.id}/delete`, alice, sudo, body);
      expect({ body, status: res.status, error: res.body.error }).toEqual({ body, status: 400, error: "confirm_mismatch" });
    }
    expect(await prisma.community.count({ where: { protocolId: club.id } })).toBe(1);
    expect(await entries()).toHaveLength(0);

    const res = await send("post", `/communities/${club.id}/delete`, alice, sudo, { confirm: "  book CLUB " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(await prisma.community.count({ where: { protocolId: club.id } })).toBe(0);
    expect(await prisma.message.count()).toBe(0);

    const told = await prisma.syncEvent.findMany({ where: { type: "community:deleted" } });
    expect(told.map((e) => e.recipientId).sort()).toEqual([(await rowOf(bob)).id, (await rowOf(carol)).id].sort());
    const pings = await prisma.federationOutboxEvent.findMany({ where: { path: `/communities/${club.id}/updated` } });
    expect(pings.map((p) => p.domain)).toEqual(["far.example"]);

    const log = await entries();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: "community.delete",
      source: "admin",
      actorUserId: alice.user.id,
      communityId: club.id,
      communityLabel: "Book Club",
      targetType: "community",
      targetId: club.id,
      targetLabel: "Book Club",
    });
    expect(JSON.stringify(log[0])).not.toContain("hello");
  });

  it("is a 404 for one that is not there (so deleting twice is harmless), and 409 for a copy of another server's, which is theirs", async () => {
    const alice = await makeAdmin("alice");
    const cached = await cachedCommunity();
    const sudo = await sudoOf(alice);
    expect((await send("post", `/communities/${newProtocolId()}/delete`, alice, sudo, { confirm: "x" })).status).toBe(404);
    const res = await send("post", `/communities/${cached.protocolId}/delete`, alice, sudo, { confirm: "Far Club" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_hosted_here");
    expect(await prisma.community.count({ where: { id: cached.id } })).toBe(1);
    // It is theirs whatever was typed: that is said before anything about the name.
    const wrongName = await send("post", `/communities/${cached.protocolId}/delete`, alice, sudo, { confirm: "not its name" });
    expect({ status: wrongName.status, error: wrongName.body.error }).toEqual({ status: 409, error: "not_hosted_here" });
  });

  it("can delete a community whose owner is an admin, since it is the community and not the account that is touched", async () => {
    const alice = await makeAdmin("alice");
    const club = await createCommunity(alice, "Mine");
    const res = await send("post", `/communities/${club.id}/delete`, alice, await sudoOf(alice), { confirm: "Mine" });
    expect(res.status).toBe(200);
    expect(await prisma.user.count({ where: { username: "alice" } })).toBe(1);
  });
});
