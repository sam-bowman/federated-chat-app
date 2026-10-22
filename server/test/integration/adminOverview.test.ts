// The admin page's overview (#206): what this server is, how it is set up and how busy it is. Every number is checked against data seeded here, so a wrong
// filter (a remote person counted, an erased account, a copy of another server's community) shows up as a wrong number. What matters most besides that:
// who can see it (admins with two-factor sign-in, nobody else), that it is read-only, and that nothing anyone wrote and no secret is in it.
import { generate } from "otplib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { createDomainPolicy } from "../../src/lib/federationPolicy.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { serverVersion } from "../../src/lib/version.js";
import { getOverview } from "../../src/modules/admin/overview.js";
import { setAdmin } from "../../src/modules/admin/service.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

const original = { ...config, federationPolicy: config.federationPolicy };
beforeEach(resetDb);
afterEach(() => {
  config.adminEnabled = true;
  config.registrationEnabled = original.registrationEnabled;
  config.registrationInviteOnly = original.registrationInviteOnly;
  config.federationEnabled = original.federationEnabled;
  config.federationPolicy = original.federationPolicy;
  config.linkPreviewsEnabled = original.linkPreviewsEnabled;
  config.directoryEnabled = original.directoryEnabled;
  config.serverName = original.serverName;
});
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Registered = Awaited<ReturnType<typeof registerUser>>;

async function makeAdmin(username: string): Promise<Registered> {
  const user = await registerUser(username, { password: PASSWORD });
  await setAdmin(username, true);
  const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(user.accessToken)).send({ password: PASSWORD })).body;
  expect((await api.post("/api/v1/auth/2fa/verify").set(authHeader(user.accessToken)).send({ code: await generate({ secret }) })).status).toBe(200);
  return user;
}
const overviewOf = async (admin: Registered) => {
  const res = await api.get("/api/v1/admin/overview").set(authHeader(admin.accessToken));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.overview;
};
const row = (username: string) => prisma.user.findFirstOrThrow({ where: { username, isRemote: false } });

describe("who can see it", () => {
  it("is not there for anyone who is not an admin", async () => {
    const bob = await registerUser("bob", { password: PASSWORD });
    expect((await api.get("/api/v1/admin/overview").set(authHeader(bob.accessToken))).status).toBe(404);
    expect((await api.get("/api/v1/admin/overview")).status).toBe(404);
    config.adminEnabled = false;
    const alice = await makeAdmin("alice");
    expect((await api.get("/api/v1/admin/overview").set(authHeader(alice.accessToken))).status).toBe(404);
  });

  it("needs two-factor sign-in", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    await setAdmin("alice", true);
    const res = await api.get("/api/v1/admin/overview").set(authHeader(alice.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("admin_requires_two_factor");
  });

  it("is only for looking: nothing here changes anything, so no sudo mode and no way to write", async () => {
    const alice = await makeAdmin("alice");
    const before = await prisma.auditLogEntry.count();
    expect((await overviewOf(alice)).people.total).toBe(1);
    for (const method of ["post", "put", "delete", "patch"] as const) {
      expect((await api[method]("/api/v1/admin/overview").set(authHeader(alice.accessToken)).send({})).status, method).toBe(404);
    }
    expect(await prisma.auditLogEntry.count()).toBe(before);
  });
});

describe("the numbers", () => {
  it("counts the people on this server, by when they were last seen, and what state they are in, and leaves out remote people and erased accounts", async () => {
    const now = Date.now();
    const alice = await makeAdmin("alice");
    for (const name of ["bob", "carol", "dave", "eve", "fay", "gus", "hank", "ivan", "joel"]) await registerUser(name, { password: PASSWORD });
    await prisma.user.updateMany({ data: { lastSeenAt: null, createdAt: new Date(now - 100 * DAY) } });
    // Each window has someone just inside it and someone just outside it, so a window that is a little too wide or too narrow is a wrong number.
    const seen = { alice: 1 * HOUR, bob: 2 * HOUR, gus: 0.5 * HOUR, hank: 30 * HOUR, carol: 3 * DAY, ivan: 7.5 * DAY, dave: 20 * DAY, joel: 30.5 * DAY, fay: 40 * DAY } as Record<string, number>;
    for (const [name, ago] of Object.entries(seen)) await prisma.user.update({ where: { id: (await row(name)).id }, data: { lastSeenAt: new Date(now - ago) } });
    const joined = { alice: 1 * DAY, bob: 1 * DAY, gus: 1 * DAY, hank: 10 * DAY, ivan: 7.5 * DAY } as Record<string, number>;
    for (const [name, ago] of Object.entries(joined)) await prisma.user.update({ where: { id: (await row(name)).id }, data: { createdAt: new Date(now - ago) } });
    await prisma.user.update({ where: { id: (await row("fay")).id }, data: { suspendedAt: new Date() } });
    await prisma.user.update({ where: { id: (await row("gus")).id }, data: { deletionRequestedAt: new Date() } });
    // Not people of this server: a cached copy of someone on another one, and an account that was erased.
    await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: "far.example", isRemote: true, lastSeenAt: new Date(), isAdmin: true } });
    await prisma.user.update({ where: { id: (await row("eve")).id }, data: { deletedAt: new Date(), lastSeenAt: new Date() } });

    const { people } = await overviewOf(alice);
    expect(people).toEqual({
      total: 9, // everyone but eve (erased) and remy (on another server)
      activeLastDay: 3, // alice, bob, gus (hank was seen 30 hours ago)
      activeLastWeek: 5, // + hank, carol (ivan was seen 7.5 days ago)
      activeLastMonth: 7, // + ivan, dave (joel was seen 30.5 days ago, fay 40)
      joinedLastWeek: 3, // alice, bob, gus (ivan joined 7.5 days ago, hank 10)
      suspended: 1,
      deletionPending: 1,
      admins: 1,
      withoutTwoFactor: 8, // everyone but alice
    });
  });

  it("counts the communities this server hosts and their channels, members and who can join, and copies of other servers' separately", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const carol = await registerUser("carol", { password: PASSWORD });
    const make = async (name: string) => (await api.post("/api/v1/communities").set(authHeader(bob.accessToken)).send({ name })).body.community as { id: string };
    const open = await make("Open");
    const closed = await make("Closed");
    const listed = await make("Listed");
    expect((await api.post(`/api/v1/communities/${open.id}/members`).set(authHeader(carol.accessToken))).status).toBe(201);
    await prisma.community.update({ where: { protocolId: closed.id }, data: { visibility: "INVITE_ONLY" } });
    await prisma.community.update({ where: { protocolId: listed.id }, data: { visibility: "PUBLIC" } });
    const row2 = await prisma.community.findUniqueOrThrow({ where: { protocolId: listed.id } });
    await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: row2.id, name: "talk", type: "VOICE", position: 5 } });
    // A copy of someone else's community, with a visibility and channels of its own that must not be counted as ours.
    const far = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "farowner", displayName: "Far", homeserverDomain: "far.example", isRemote: true } });
    const cached = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far Club", ownerId: far.id, homeserverDomain: "far.example", isRemote: true, visibility: "LOCAL_ONLY" } });
    await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: cached.id, name: "far-talk", type: "VOICE", position: 1 } });
    await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: cached.id, name: "far-text", type: "TEXT", position: 2 } });
    await prisma.communityMember.create({ data: { communityId: cached.id, userId: far.id } });

    const { communities } = await overviewOf(alice);
    expect(communities).toEqual({
      hosted: 3,
      copiesOfOthers: 1,
      memberships: 4, // bob owns three (members of each) and carol joined one
      textChannels: 3,
      voiceChannels: 1,
      byVisibility: { UNLISTED: 1, PUBLIC: 1, INVITE_ONLY: 1, LOCAL_ONLY: 0 },
    });
  });

  it("counts the servers it has looked up and what is waiting to be sent to them", async () => {
    const alice = await makeAdmin("alice");
    for (const domain of ["a.example", "b.example"]) await prisma.federationPeer.create({ data: { domain, baseUrl: `https://${domain}`, publicKey: "k" } });
    const event = (over: object) => prisma.federationOutboxEvent.create({ data: { domain: "a.example", path: "/x", body: {}, ...over } });
    const oldest = new Date(Date.now() - 3 * HOUR);
    await event({ createdAt: oldest });
    await event({ attempts: 2, createdAt: new Date(Date.now() - 1 * HOUR) });
    await event({});
    await event({ status: "IN_PROGRESS" });
    await event({ status: "FAILED", attempts: 9, createdAt: new Date(Date.now() - 9 * HOUR) });
    await event({ status: "FAILED", attempts: 9 });

    const { federation } = await overviewOf(alice);
    expect(federation.knownServers).toBe(2);
    expect(federation.queue).toEqual({ pending: 3, retrying: 1, inProgress: 1, failed: 2, oldestPendingAt: oldest.toISOString() });
  });

  it("says nothing is waiting, and since when, only when something is", async () => {
    const alice = await makeAdmin("alice");
    expect((await overviewOf(alice)).federation.queue).toEqual({ pending: 0, retrying: 0, inProgress: 0, failed: 0, oldestPendingAt: null });
  });

  it("counts the audit entries of the last day and the invites that can still be used", async () => {
    const alice = await makeAdmin("alice");
    await prisma.auditLogEntry.deleteMany();
    const entry = (createdAt: Date) => prisma.auditLogEntry.create({ data: { source: "api", action: "member.kick", actorLabel: "x", createdAt } });
    await entry(new Date());
    await entry(new Date(Date.now() - 2 * HOUR));
    await entry(new Date(Date.now() - 30 * HOUR)); // just outside the day
    await entry(new Date(Date.now() - 3 * DAY));
    await prisma.registrationInvite.createMany({
      data: [{ code: "AAAAAAAAAA" }, { code: "BBBBBBBBBB", maxUses: null }, { code: "CCCCCCCCCC", revokedAt: new Date() }, { code: "DDDDDDDDDD", expiresAt: new Date(Date.now() - 1000) }, { code: "EEEEEEEEEE", maxUses: 1, uses: 1 }],
    });
    const overview = await overviewOf(alice);
    expect(overview.auditEntriesLastDay).toBe(2);
    expect(overview.registration.activeInvites).toBe(2);
  });
});

describe("how the server is set up", () => {
  it("says what it is, from the discovery document's own values", async () => {
    const alice = await makeAdmin("alice");
    config.serverName = "Bowmans Chat";
    const { server } = await overviewOf(alice);
    expect(server).toEqual({ name: "Bowmans Chat", domain: config.domain, version: serverVersion, storage: config.storageDriver, redis: Boolean(config.redisUrl) });
  });

  it("says whether people can register and whether a code is asked for, as the discovery document does", async () => {
    const alice = await makeAdmin("alice");
    config.registrationEnabled = true;
    config.registrationInviteOnly = false;
    expect((await overviewOf(alice)).registration).toMatchObject({ enabled: true, inviteOnly: false });
    config.registrationInviteOnly = true;
    expect((await overviewOf(alice)).registration).toMatchObject({ enabled: true, inviteOnly: true });
    // Registration off wins: a code is not asked for when nobody can register.
    config.registrationEnabled = false;
    expect((await overviewOf(alice)).registration).toMatchObject({ enabled: false, inviteOnly: false });
  });

  it("says which features are on, and how many servers it is told to talk to or not", async () => {
    const alice = await makeAdmin("alice");
    config.federationEnabled = false;
    config.linkPreviewsEnabled = true;
    config.directoryEnabled = true;
    config.federationPolicy = createDomainPolicy(["a.example", "b.example", "c.example"], []);
    let overview = await overviewOf(alice);
    expect(overview.features).toEqual({ federation: false, voice: config.voice.enabled, directory: true, linkPreviews: true });
    expect(overview.federation).toMatchObject({ enabled: false, allowedServers: 3, blockedServers: 0 });
    config.federationEnabled = true;
    config.linkPreviewsEnabled = false;
    config.directoryEnabled = false;
    config.federationPolicy = createDomainPolicy([], ["bad.example", "worse.example"]);
    overview = await overviewOf(alice);
    expect(overview.features).toMatchObject({ federation: true, directory: false, linkPreviews: false });
    expect(overview.federation).toMatchObject({ enabled: true, allowedServers: 0, blockedServers: 2 });
  });

  it("shows the settings in effect, with the name of the variable that sets each", async () => {
    const alice = await makeAdmin("alice");
    // Two that are the same by default would not show a default and a limit mixed up.
    const saved = { d: config.contactPolicyDefault, l: config.contactPolicyLimit };
    config.contactPolicyDefault = "SHARED_COMMUNITY";
    config.contactPolicyLimit = "LOCAL_ONLY";
    const { settings } = await overviewOf(alice).finally(() => {
      config.contactPolicyDefault = saved.d;
      config.contactPolicyLimit = saved.l;
    });
    expect(Object.fromEntries(settings.map((s: { setting: string; value: string }) => [s.setting, s.value]))).toEqual({
      ACCOUNT_DELETION_GRACE_DAYS: String(config.accountDeletionGraceDays),
      AUDIT_LOG_RETENTION_DAYS: String(config.auditLogRetentionDays),
      COMMUNITY_VISIBILITY_DEFAULT: config.communityVisibilityDefault,
      COMMUNITY_VISIBILITY_LIMIT: config.communityVisibilityLimit,
      FEDERATION_CONTACT_POLICY_DEFAULT: "SHARED_COMMUNITY",
      FEDERATION_CONTACT_POLICY_LIMIT: "LOCAL_ONLY",
      FEDERATION_USER_DISCOVERABILITY: config.userDiscoverability,
      DIRECTORY_PEOPLE: config.directoryPeople,
      MAX_UPLOAD_BYTES: String(config.maxUploadBytes),
    });
  });
});

describe("what it never contains", () => {
  it("has exactly these fields, and nothing a person or a community was called, wrote or has as a secret", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD, displayName: "Bobby Tables" });
    const community = (await api.post("/api/v1/communities").set(authHeader(bob.accessToken)).send({ name: "Secret Society", description: "a secret description" })).body.community;
    await api.post(`/api/v1/channels/${community.channels[0].id}/messages`).set(authHeader(bob.accessToken)).send({ content: "a secret message" });
    await prisma.federationPeer.create({ data: { domain: "peer-secret.example", baseUrl: "https://peer-secret.example", publicKey: "a-public-key-value" } });
    config.federationPolicy = createDomainPolicy(["allowed-secret.example"], []);

    const overview = await overviewOf(alice);
    expect(Object.keys(overview).sort()).toEqual(["auditEntriesLastDay", "communities", "features", "federation", "generatedAt", "people", "registration", "server", "settings"]);
    expect(Object.keys(overview.server).sort()).toEqual(["domain", "name", "redis", "storage", "version"]);
    expect(Object.keys(overview.federation).sort()).toEqual(["allowedServers", "blockedServers", "enabled", "knownServers", "queue"]);
    expect(Object.keys(overview.registration).sort()).toEqual(["activeInvites", "enabled", "inviteOnly"]);
    const everything = JSON.stringify(overview);
    for (const secret of [
      "bob",
      "Bobby",
      "Secret Society",
      "a secret description",
      "a secret message",
      "peer-secret",
      "allowed-secret",
      "a-public-key-value",
      config.jwtAccessSecret,
      config.jwtRefreshSecret,
      config.databaseUrl,
      alice.accessToken,
    ]) {
      expect(everything, secret).not.toContain(secret);
    }
  });

  it("is built for a moment that is given, so a number is for that moment", async () => {
    const alice = await makeAdmin("alice");
    await prisma.user.update({ where: { id: (await row("alice")).id }, data: { lastSeenAt: new Date("2026-06-01T12:00:00Z") } });
    expect((await getOverview(new Date("2026-06-01T13:00:00Z"))).people.activeLastDay).toBe(1);
    expect((await getOverview(new Date("2026-06-01T13:00:00Z"))).generatedAt).toEqual(new Date("2026-06-01T13:00:00Z"));
    expect((await getOverview(new Date("2026-06-03T13:00:00Z"))).people.activeLastDay).toBe(0);
    expect((await getOverview(new Date("2026-06-03T13:00:00Z"))).people.activeLastWeek).toBe(1);
    expect(alice.user.id).toBeTruthy();
  });
});
