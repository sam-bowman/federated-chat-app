// Reports about content on another server (#58, docs/content-reports.md "Reports about content on another server"), in both directions:
// the HOME server taking a report from a member whose own server only carries it, and the REPORTER'S server carrying it. The rules that
// matter: the home server builds the snapshot from its own copy and runs the local checks, nothing is told to the person reported, an older
// server is told apart from a real "not found", and what the reporter's server keeps is only that a report was made.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { MAX_REPORTS_PER_DOMAIN_PER_HOUR, MAX_REPORTS_PER_HOUR } from "../../src/lib/reports.js";
import { listReports } from "../../src/modules/reports/service.js";
import { purgeAccount } from "../../src/modules/users/deletion.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
const as = (user: Registered) => authHeader(user.accessToken);
const rows = () => prisma.report.findMany({ orderBy: { id: "asc" } });

// ---- the home server's side ---------------------------------------------------------------------------------------------------

describe("taking a report from a member on another server (home side)", () => {
  async function setup() {
    const owner = await registerUser("owner");
    const bob = await registerUser("bob");
    const peer = await registerTestPeer("r.example");
    const club = (await api.post("/api/v1/communities").set(as(owner)).send({ name: "Club" })).body.community as { id: string; channels: { id: string }[] };
    await api.post(`/api/v1/communities/${club.id}/members`).set(as(bob));
    const robin = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "robin", displayName: "Robin", homeserverDomain: peer.domain, isRemote: true } });
    const club_ = await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } });
    await prisma.communityMember.create({ data: { communityId: club_.id, userId: robin.id } });
    const said = async (content: string) => (await api.post(`/api/v1/channels/${club.channels[0].id}/messages`).set(as(bob)).send({ content })).body.message.id as string;
    const send = (body: object, path = `/federation/v1/communities/${club.id}/reports`, from = peer) => signedPost(from, path, body);
    return { owner, bob, peer, club, robin, said, send };
  }
  const report = (id: string, extra: object = {}) => ({ username: "robin", kind: "message", id, reason: "spam", ...extra });

  it("takes it as a local report: the snapshot is read from this server's own copy, never from what the other server sends", async () => {
    const { owner, club, said, send, robin } = await setup();
    const id = await said("buy my pills");

    const res = await send(report(id, { details: "every day", snapshot: { type: "message", text: "something innocent" }, text: "something innocent" }));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ received: true });
    const [row] = await rows();
    expect(row).toMatchObject({
      kind: "MESSAGE",
      scope: "COMMUNITY",
      reporterId: robin.protocolId,
      reporterLabel: "@robin:r.example",
      reporterDomain: "r.example",
      details: "every day",
      snapshot: { type: "message", text: "buy my pills" },
    });
    // The community's moderators see it, with the reporter as a person on the other server.
    const queue = await api.get(`/api/v1/communities/${club.id}/reports`).set(as(owner));
    expect(queue.body.reports).toHaveLength(1);
    expect(queue.body.reports[0].reporter.label).toBe("@robin:r.example");
    expect(queue.body.reports[0].snapshot.text).toBe("buy my pills");
  });

  it("reports the community itself to the admins alone", async () => {
    const { club, send } = await setup();
    const res = await send({ username: "robin", kind: "community", id: club.id, reason: "illegal" });
    expect(res.status).toBe(201);
    expect(await rows()).toMatchObject([{ kind: "COMMUNITY", scope: "SERVER", snapshot: { type: "community", name: "Club" } }]);
  });

  it("tells no one: no event, no audit entry, nothing sent on to any server", async () => {
    const { said, send } = await setup();
    const id = await said("reported");
    const events = await prisma.syncEvent.count();
    const audits = await prisma.auditLogEntry.count();
    const outbox = await prisma.federationOutboxEvent.count();

    await send(report(id));

    expect(await prisma.syncEvent.count()).toBe(events);
    expect(await prisma.auditLogEntry.count()).toBe(audits);
    expect(await prisma.federationOutboxEvent.count()).toBe(outbox);
  });

  it("says the same for a message that is not here, not in this community, deleted, or in a community the other server has no member in", async () => {
    const { owner, bob, said, send, club, robin } = await setup();
    const other = (await api.post("/api/v1/communities").set(as(owner)).send({ name: "Other" })).body.community as { id: string; channels: { id: string }[] };
    await api.post(`/api/v1/communities/${other.id}/members`).set(as(bob));
    // The reporter is a member of the other community too, so the path is the only thing that can tell the two apart.
    const other_ = await prisma.community.findUniqueOrThrow({ where: { protocolId: other.id } });
    await prisma.communityMember.create({ data: { communityId: other_.id, userId: robin.id } });
    const elsewhere = (await api.post(`/api/v1/channels/${other.channels[0].id}/messages`).set(as(bob)).send({ content: "in the other one" })).body.message.id as string;
    const gone = await said("gone");
    await api.delete(`/api/v1/messages/${gone}`).set(as(bob));
    const stranger = await registerTestPeer("nobody.example");

    const missing = await send(report(newProtocolId()));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "report_target_not_found" });
    for (const res of [
      await send(report(elsewhere)), // a message of another community, with this community's id in the path
      await send(report(gone)),
      await send(report(newProtocolId()), `/federation/v1/communities/${newProtocolId()}/reports`), // no such community
      await send(report(await said("hi")), `/federation/v1/communities/${club.id}/reports`, stranger), // that server has no member here
      await send({ username: "robin", kind: "community", id: other.id, reason: "spam" }), // another community's id as the community
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(missing.body);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("is advertised in the discovery document, for anyone who wants to know", async () => {
    const res = await api.get("/.well-known/communication-platform");
    expect(res.body.features.reports).toBe(true);
  });

  it("is not the generic not-found an older server would answer for a path it does not know", async () => {
    const peer = await registerTestPeer("r.example");
    const unknown = await signedPost(peer, "/federation/v1/communities/x/something-that-does-not-exist", {});
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "not_found" });
  });

  it("refuses a person from that server who is not a member of this community, or is not known", async () => {
    const { said, send, club, robin } = await setup();
    const id = await said("hi");
    await prisma.communityMember.deleteMany({ where: { userId: robin.id } });
    const second = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "sam", displayName: "Sam", homeserverDomain: "r.example", isRemote: true } });
    const club_ = await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } });
    await prisma.communityMember.create({ data: { communityId: club_.id, userId: second.id } }); // the domain still has a member here

    for (const username of ["robin", "nobody"]) {
      const res = await send(report(id, { username }));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "not_a_member" });
    }
    expect(await rows()).toHaveLength(0);
  });

  it("does not take a report about the member's own message, or the same thing twice", async () => {
    const { said, send, club, robin } = await setup();
    const club_ = await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id }, include: { channels: true } });
    const own = await prisma.message.create({ data: { protocolId: newProtocolId(), channelId: club_.channels[0].id, senderId: robin.id, content: "mine" } });
    const id = await said("theirs");

    expect((await send(report(own.protocolId))).body).toEqual({ error: "cannot_report_self" });
    expect((await send(report(id))).status).toBe(201);
    const again = await send(report(id));
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "already_reported" });
    expect(await rows()).toHaveLength(1);
  });

  it("takes only a message or the community, with a real reason, from a well-formed request", async () => {
    const { said, send } = await setup();
    const id = await said("x");
    for (const body of [
      report(id, { kind: "user" }),
      report(id, { reason: "rude" }),
      report(id, { details: "x".repeat(501) }),
      { kind: "message", id, reason: "spam" },
      report("", {}),
    ]) {
      expect((await send(body)).status).toBe(400);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("limits each person, and the other server as a whole, whoever it says its people are", async () => {
    const { said, send, club, peer, robin } = await setup();
    const id = await said("one more");
    const seed = (count: number, domain: string, reporterId: string) =>
      prisma.report.createMany({
        data: Array.from({ length: count }, (_, i) => ({ protocolId: newProtocolId(), kind: "USER" as const, scope: "SERVER" as const, reason: "spam", reporterId, reporterLabel: "x", reporterDomain: domain, targetKey: `user:${newProtocolId()}`, targetId: `t${i}`, snapshot: {} })),
      });

    await seed(MAX_REPORTS_PER_HOUR, "r.example", robin.protocolId);
    const person = await send(report(id));
    expect(person.status).toBe(429);
    expect(person.body).toEqual({ error: "too_many_reports" });

    // Other people from the same server: each is fine alone, but the server has sent too many.
    await prisma.report.deleteMany();
    for (let n = 0; n < MAX_REPORTS_PER_DOMAIN_PER_HOUR / MAX_REPORTS_PER_HOUR; n++) await seed(MAX_REPORTS_PER_HOUR, "r.example", `person-${n}`);
    const server = await send(report(id));
    expect(server.status).toBe(429);

    // A different server is unaffected.
    const other = await registerTestPeer("fine.example");
    const fine = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "fay", displayName: "Fay", homeserverDomain: other.domain, isRemote: true } });
    const club_ = await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } });
    await prisma.communityMember.create({ data: { communityId: club_.id, userId: fine.id } });
    expect((await send(report(id, { username: "fay" }), `/federation/v1/communities/${club.id}/reports`, other)).status).toBe(201);
    expect(peer.domain).toBe("r.example");
  });

  it("only counts what was sent in the last hour", async () => {
    const { said, send } = await setup();
    const id = await said("later");
    await prisma.report.createMany({
      data: Array.from({ length: MAX_REPORTS_PER_DOMAIN_PER_HOUR }, (_, i) => ({ protocolId: newProtocolId(), kind: "USER" as const, scope: "SERVER" as const, reason: "spam", reporterId: `p${i}`, reporterLabel: "x", reporterDomain: "r.example", targetKey: `user:${newProtocolId()}`, targetId: `t${i}`, snapshot: {}, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })),
    });
    expect((await send(report(id))).status).toBe(201);
  });

  it("forgets who reported when that person's account is erased on their own server", async () => {
    const { said, send, peer, robin } = await setup();
    await send(report(await said("x")));

    expect((await signedPost(peer, "/federation/v1/account-deleted", { protocolId: robin.protocolId })).status).toBe(204);

    const [row] = await rows();
    expect(row).toMatchObject({ reporterId: null, reporterLabel: "Deleted user", reporterDomain: null });
  });

  it("answers 409 not_community_home when this server only has a copy of the community", async () => {
    const { peer, robin } = await setup();
    const copy = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Copy", ownerId: robin.id, homeserverDomain: "far.example", isRemote: true } });
    const res = await signedPost(peer, `/federation/v1/communities/${copy.protocolId}/reports`, { username: "robin", kind: "community", id: copy.protocolId, reason: "spam" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "not_community_home" });
  });
});

// ---- the reporter's server ----------------------------------------------------------------------------------------------------

describe("carrying a report to the community's home server (reporter's side)", () => {
  const HOME = "home.invalid";
  let server: Server;
  let answer: { status: number; body: unknown };
  let received: { method?: string; url?: string; body: Record<string, unknown>; origin?: string }[];

  beforeEach(async () => {
    answer = { status: 201, body: { received: true } };
    received = [];
    server = createServer((req: IncomingMessage, res) => {
      if (req.url === "/.well-known/communication-platform") {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ federation: { enabled: true, publicKey: "home-key", apiBase: "/federation/v1" } }));
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : {}, origin: req.headers["x-federation-origin"] as string | undefined });
        res.statusCode = answer.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    config.federationPeerOverrides[HOME] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    delete config.federationPeerOverrides[HOME];
    config.federationEnabled = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A cached copy of a community hosted at HOME, with `member` in it and a message by someone there. */
  async function cached(member: Registered) {
    const host = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "host", displayName: "Host", homeserverDomain: HOME, isRemote: true } });
    const community = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far", ownerId: host.id, homeserverDomain: HOME, isRemote: true } });
    const channel = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: community.id, name: "general" } });
    const me = await prisma.user.findUniqueOrThrow({ where: { protocolId: member.user.id } });
    await prisma.communityMember.create({ data: { communityId: community.id, userId: me.id } });
    const message = await prisma.message.create({ data: { protocolId: newProtocolId(), channelId: channel.id, senderId: host.id, content: "words only home has" } });
    return { community, message, me };
  }
  const report = (user: Registered, kind: "message" | "community", id: string, extra: object = {}) =>
    api.post("/api/v1/reports").set(as(user)).send({ kind, id, reason: "harassment", ...extra });

  it("sends the home server what the person chose to say and nothing of the message, and keeps only that it was made", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);

    const res = await report(alice, "message", far.message.protocolId, { details: "  rude to me  " });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ received: true });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "POST", url: `/federation/v1/communities/${far.community.protocolId}/reports` });
    expect(received[0].body).toEqual({ username: "alice", kind: "message", id: far.message.protocolId, reason: "harassment", details: "rude to me" });
    expect(JSON.stringify(received[0].body)).not.toContain("words only home has");
    const [row] = await rows();
    expect(row).toMatchObject({ scope: "REMOTE", reporterId: alice.user.id, details: null, snapshot: {}, communityId: far.community.id, targetId: far.message.protocolId });
  });

  it("carries a report about the community itself the same way", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    expect((await report(alice, "community", far.community.protocolId)).status).toBe(201);
    expect(received[0].body).toMatchObject({ kind: "community", id: far.community.protocolId });
    expect(await rows()).toMatchObject([{ kind: "COMMUNITY", scope: "REMOTE" }]);
  });

  it("is in no queue and not counted as open here: nobody on this server can close it", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    await report(alice, "message", far.message.protocolId);
    const viewer = { protocolId: newProtocolId(), username: "root", homeserverDomain: "test.local" };

    expect(await listReports({ type: "admin" }, viewer)).toMatchObject({ reports: [], open: 0 });
    expect(await listReports({ type: "community", communityId: far.community.id }, viewer)).toMatchObject({ reports: [], open: 0 });
  });

  it("does not ask again for the same thing, and says so", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    await report(alice, "message", far.message.protocolId);

    const again = await report(alice, "message", far.message.protocolId);

    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "already_reported" });
    expect(received).toHaveLength(1);
  });

  it("records it when the home server already had it, so it is not asked again", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    answer = { status: 409, body: { error: "already_reported" } };

    const res = await report(alice, "message", far.message.protocolId);

    expect(res.status).toBe(409);
    expect(await rows()).toHaveLength(1);
    answer = { status: 201, body: { received: true } };
    await report(alice, "message", far.message.protocolId);
    expect(received).toHaveLength(1);
  });

  it("tells the person each thing the home server can say, and records nothing for a report that was not taken", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    const cases: [number, unknown, number, string][] = [
      [404, { error: "report_target_not_found" }, 404, "not_found"],
      [403, { error: "not_a_member" }, 403, "not_a_member"],
      [429, { error: "too_many_reports" }, 429, "too_many_reports"],
      [400, { error: "cannot_report_self" }, 400, "cannot_report_self"],
      [500, { error: "boom" }, 502, "federation_unreachable"],
      // The other server is private, or does not talk to this one: from here that is a server that cannot be reached.
      [403, { error: "federation_disabled" }, 502, "federation_unreachable"],
      [403, { error: "federation_domain_blocked" }, 502, "federation_unreachable"],
    ];
    for (const [status, body, expectedStatus, expectedError] of cases) {
      answer = { status, body };
      const res = await report(alice, "message", far.message.protocolId);
      expect([res.status, res.body.error], `${status} ${JSON.stringify(body)}`).toEqual([expectedStatus, expectedError]);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("tells a server that has never heard of reports from a real 'not found': the person gets what they got before relaying existed", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    answer = { status: 404, body: { error: "not_found" } }; // what the federation router says for a path it does not have

    const res = await report(alice, "message", far.message.protocolId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "remote_community" });
    expect(await rows()).toHaveLength(0);
  });

  it("says the other server cannot be reached, and keeps nothing, so the person can try again", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    delete config.federationPeerOverrides[HOME];

    const res = await report(alice, "message", far.message.protocolId);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "federation_unreachable" });
    expect(await rows()).toHaveLength(0);
  });

  it("says this server is private when it is, without trying", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    config.federationEnabled = false;

    const res = await report(alice, "message", far.message.protocolId);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "federation_disabled" });
    expect(received).toHaveLength(0);
  });

  it("only what the person can see, and not their own", async () => {
    const alice = await registerUser("alice");
    const stranger = await registerUser("stranger");
    const far = await cached(alice);
    const own = await prisma.message.create({ data: { protocolId: newProtocolId(), channelId: (await prisma.channel.findFirstOrThrow({ where: { communityId: far.community.id } })).id, senderId: far.me.id, content: "mine" } });

    expect((await report(stranger, "message", far.message.protocolId)).status).toBe(404);
    expect((await report(stranger, "community", far.community.protocolId)).status).toBe(404);
    expect((await report(alice, "message", own.protocolId)).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("counts what it carried towards the hourly limit, but not towards the open ones", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    const seed = (count: number, over: object = {}) =>
      prisma.report.createMany({
        data: Array.from({ length: count }, (_, i) => ({ protocolId: newProtocolId(), kind: "MESSAGE" as const, scope: "REMOTE" as const, reason: "spam", reporterId: alice.user.id, reporterLabel: "x", targetKey: `message:${newProtocolId()}`, targetId: `t${i}`, snapshot: {}, ...over })),
      });

    await seed(30, { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }); // thirty open-looking ones, long ago
    expect((await report(alice, "message", far.message.protocolId)).status).toBe(201);

    await prisma.report.deleteMany();
    await seed(MAX_REPORTS_PER_HOUR);
    const blocked = await report(alice, "message", far.message.protocolId);
    expect(blocked.status).toBe(429);
    expect(received).toHaveLength(1);
  });

  it("is not counted in the history an admin sees of a reporter: those reports are not this server's to weigh", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const far = await cached(alice);
    await report(alice, "message", far.message.protocolId);
    await api.post("/api/v1/reports").set(as(alice)).send({ kind: "user", id: bob.user.id, reason: "spam" });
    const viewer = { protocolId: newProtocolId(), username: "root", homeserverDomain: "test.local" };

    const { reports } = await listReports({ type: "admin" }, viewer);

    expect(reports).toHaveLength(1);
    expect(reports[0].reporter.history).toEqual({ total: 1, dismissed: 0 });
  });

  it("is deleted, not just blanked, with the account of the person who made it", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    await report(alice, "message", far.message.protocolId);

    expect(await purgeAccount(far.me.id)).toEqual({ ok: true });

    expect(await rows()).toHaveLength(0);
  });

  it("is deleted when the cached copy of the community goes", async () => {
    const alice = await registerUser("alice");
    const far = await cached(alice);
    await report(alice, "message", far.message.protocolId);

    await prisma.community.delete({ where: { id: far.community.id } });

    expect(await rows()).toHaveLength(0);
  });
});
