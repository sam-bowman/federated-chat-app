// Registration invites on the admin page's API (#206): an admin makes, sees and revokes the codes an invite-only server asks for. What matters
// is that it needs the same proof as everything else that changes something, that a code made here really lets a person register (and a revoked one
// does not), and that a code is never in the audit log, which only names an invite by its id and the end of the code.
import jwt from "jsonwebtoken";
import { generate } from "otplib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { runRegistrationInvitesCli } from "../../src/cli/registrationInvites.js";
import { setAdmin } from "../../src/modules/admin/service.js";
import { purgeAccount } from "../../src/modules/users/deletion.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterEach(() => {
  config.adminEnabled = true;
  config.registrationInviteOnly = false;
  config.registrationEnabled = true;
});
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";
const DAY = 86_400_000;
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
const post = (path: string, as: Registered, sudo?: string, body: object = {}) => {
  const request = api.post(`/api/v1/admin${path}`).set(authHeader(as.accessToken));
  if (sudo) request.set("X-Admin-Sudo", sudo);
  return request.send(body);
};
const entries = () => prisma.auditLogEntry.findMany({ orderBy: { id: "asc" } });
const register = (username: string, inviteCode?: string) => api.post("/api/v1/auth/register").send({ username, password: PASSWORD, inviteCode });
const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

describe("who can reach it", () => {
  it("is not there for anyone who is not an admin, for the list, a new code or a revoke", async () => {
    const bob = await registerUser("bob", { password: PASSWORD });
    const invite = await prisma.registrationInvite.create({ data: { code: "ABCDEFGHJK" } });
    expect((await get("/registration-invites", bob)).status).toBe(404);
    expect((await post("/registration-invites", bob, "x", { maxUses: 1 })).status).toBe(404);
    expect((await post(`/registration-invites/${invite.id}/revoke`, bob, "x")).status).toBe(404);
    expect((await api.get("/api/v1/admin/registration-invites")).status).toBe(404);
    expect(await prisma.registrationInvite.count()).toBe(1);
  });

  it("needs two-factor sign-in to see the codes", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    await setAdmin("alice", true);
    const res = await get("/registration-invites", alice);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("admin_requires_two_factor");
  });

  it("needs sudo mode to make a code or revoke one, and a token of another kind or admin does not count", async () => {
    const alice = await makeAdmin("alice");
    const invite = await prisma.registrationInvite.create({ data: { code: "ABCDEFGHJK" } });
    expect((await post("/registration-invites", alice, undefined, {})).body.error).toBe("sudo_required");
    expect((await post(`/registration-invites/${invite.id}/revoke`, alice)).body.error).toBe("sudo_required");
    expect((await post("/registration-invites", alice, "garbage", {})).body.error).toBe("sudo_required");
    const access = jwt.sign({ sub: alice.user.id }, config.jwtAccessSecret, { expiresIn: 600 });
    expect((await post("/registration-invites", alice, access, {})).body.error).toBe("sudo_required");
    const bob = await makeAdmin("bob");
    const bobsToken = await sudoOf(bob);
    expect((await post("/registration-invites", alice, bobsToken, {})).body.error).toBe("sudo_required");
    expect(await prisma.registrationInvite.count()).toBe(1);
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt).toBeNull();
    expect(await entries()).toHaveLength(0);
  });
});

describe("making codes", () => {
  it("makes one single-use code that lasts a week when told nothing, and answers with it", async () => {
    const alice = await makeAdmin("alice");
    const res = await post("/registration-invites", alice, await sudoOf(alice));
    expect(res.status).toBe(201);
    expect(res.body.invites).toHaveLength(1);
    const [made] = res.body.invites;
    expect(made.code).toMatch(CODE);
    expect(made).toMatchObject({ note: null, status: "active", uses: 0, maxUses: 1, revokedAt: null, joined: [] });
    const days = (new Date(made.expiresAt).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    const stored = await prisma.registrationInvite.findUniqueOrThrow({ where: { code: made.code } });
    expect(stored.id).toBe(made.id);
  });

  it("takes the number of uses, the lifetime, a note and how many to make; null means no limit", async () => {
    const alice = await makeAdmin("alice");
    const res = await post("/registration-invites", alice, await sudoOf(alice), { maxUses: 5, expiresInDays: 30, note: "  Alex from work  ", count: 3 });
    expect(res.status).toBe(201);
    expect(res.body.invites).toHaveLength(3);
    expect(new Set(res.body.invites.map((i: { code: string }) => i.code)).size).toBe(3);
    for (const invite of res.body.invites) {
      expect(invite.maxUses).toBe(5);
      expect(invite.note).toBe("Alex from work");
      expect((new Date(invite.expiresAt).getTime() - Date.now()) / DAY).toBeGreaterThan(29.99);
    }
    const open = (await post("/registration-invites", alice, await sudoOf(alice), { maxUses: null, expiresInDays: null, note: "" })).body.invites[0];
    expect(open.maxUses).toBeNull();
    expect(open.expiresAt).toBeNull();
    expect(open.note).toBeNull();
  });

  it("refuses what is out of range, wrongly typed or too long, and makes nothing", async () => {
    const alice = await makeAdmin("alice");
    const bad: object[] = [
      { maxUses: 0 },
      { maxUses: 10_001 },
      { maxUses: 1.5 },
      { maxUses: "5" },
      { expiresInDays: 0 },
      { expiresInDays: 3651 },
      { count: 0 },
      { count: 51 },
      { note: "x".repeat(101) },
      { note: 5 },
    ];
    for (const body of bad) {
      const res = await post("/registration-invites", alice, await sudoOf(alice), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    }
    expect(await prisma.registrationInvite.count()).toBe(0);
    // The edges are fine.
    const edge = await post("/registration-invites", alice, await sudoOf(alice), { maxUses: 10_000, expiresInDays: 3650, count: 50, note: "x".repeat(100) });
    expect(edge.status).toBe(201);
    expect(edge.body.invites).toHaveLength(50);
  });

  it("records each code as the admin's, from the admin page, and never writes the code or the note", async () => {
    const alice = await makeAdmin("alice");
    const res = await post("/registration-invites", alice, await sudoOf(alice), { maxUses: 2, expiresInDays: 10, note: "Secret note about Alex", count: 2 });
    const log = await entries();
    expect(log).toHaveLength(2);
    for (const [i, entry] of log.entries()) {
      const invite = res.body.invites[i];
      expect(entry).toMatchObject({
        action: "registration_invite.create",
        source: "admin",
        actorUserId: alice.user.id,
        targetType: "registration_invite",
        targetId: invite.id,
        targetLabel: `…${invite.code.slice(-4)}`,
      });
      expect(entry.details).toEqual({ maxUses: 2, days: 10, hasNote: true });
      const everything = JSON.stringify(entry);
      expect(everything).not.toContain(invite.code);
      expect(everything).not.toContain("Alex");
    }
  });

  it("makes a code that really lets someone register on an invite-only server, once", async () => {
    const alice = await makeAdmin("alice");
    config.registrationInviteOnly = true;
    const [invite] = (await post("/registration-invites", alice, await sudoOf(alice), { note: "for Carol" })).body.invites;
    expect((await register("carol")).body.error).toBe("registration_invite_required");
    expect((await register("carol", invite.code)).status).toBe(201);
    expect((await register("dave", invite.code)).body.error).toBe("registration_invite_used_up");

    const shown = (await get("/registration-invites?all=1", alice)).body.invites.find((i: { id: string }) => i.id === invite.id);
    expect(shown).toMatchObject({ uses: 1, status: "used_up", joined: ["carol"] });
  });
});

describe("the list", () => {
  it("shows the codes that can still be used, newest first, and with all=1 the others too", async () => {
    const alice = await makeAdmin("alice");
    const now = Date.now();
    const make = (code: string, over: object, age: number) => prisma.registrationInvite.create({ data: { code, createdAt: new Date(now - age), ...over } });
    const active = await make("AAAAAAAAAA", { note: "older" }, 3000);
    const newest = await make("BBBBBBBBBB", { maxUses: null }, 1000);
    await make("CCCCCCCCCC", { revokedAt: new Date() }, 2000);
    await make("DDDDDDDDDD", { expiresAt: new Date(now - 1000) }, 2500);
    await make("EEEEEEEEEE", { maxUses: 1, uses: 1 }, 2600);

    const res = await get("/registration-invites", alice);
    expect(res.status).toBe(200);
    expect(res.body.invites.map((i: { id: string }) => i.id)).toEqual([newest.id, active.id]);
    expect(res.body.total).toBe(2);
    expect(res.body.invites[1]).toMatchObject({ code: "AAAAAAAAAA", note: "older", status: "active" });

    const every = (await get("/registration-invites?all=true", alice)).body;
    expect(every.total).toBe(5);
    expect(every.invites.map((i: { code: string }) => i.code)).toEqual(["BBBBBBBBBB", "CCCCCCCCCC", "DDDDDDDDDD", "EEEEEEEEEE", "AAAAAAAAAA"]);
    expect(every.invites.map((i: { status: string }) => i.status)).toEqual(["active", "revoked", "expired", "used_up", "active"]);
    expect((await get("/registration-invites?all=maybe", alice)).status).toBe(400);
  });

  it("answers with at most 200, newest first, and says how many there are", async () => {
    const alice = await makeAdmin("alice");
    const now = Date.now();
    await prisma.registrationInvite.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({ code: `C${String(i).padStart(9, "0")}`, createdAt: new Date(now - i * 1000) })),
    });
    const res = await get("/registration-invites", alice);
    expect(res.body.invites).toHaveLength(200);
    expect(res.body.total).toBe(205);
    expect(res.body.invites[0].code).toBe("C000000000");
    expect(res.body.invites[199].code).toBe("C000000199");
  });

  it("says whether the codes matter right now", async () => {
    const alice = await makeAdmin("alice");
    expect((await get("/registration-invites", alice)).body.registration).toEqual({ enabled: true, inviteOnly: false });
    config.registrationInviteOnly = true;
    expect((await get("/registration-invites", alice)).body.registration).toEqual({ enabled: true, inviteOnly: true });
    config.registrationEnabled = false;
    expect((await get("/registration-invites", alice)).body.registration.enabled).toBe(false);
  });

  it("names the accounts that joined with a code, but not one that was erased, and shows nothing but what it should", async () => {
    const alice = await makeAdmin("alice");
    config.registrationInviteOnly = true;
    const [invite] = (await post("/registration-invites", alice, await sudoOf(alice), { maxUses: 5 })).body.invites;
    await register("carol", invite.code);
    await register("dave", invite.code);
    const dave = await prisma.user.findFirstOrThrow({ where: { username: "dave" } });
    expect((await purgeAccount(dave.id)).ok).toBe(true);
    const shown = (await get("/registration-invites", alice)).body.invites[0];
    expect(shown.joined).toEqual(["carol"]);
    expect(shown.uses).toBe(2);
    expect(Object.keys(shown).sort()).toEqual(["code", "createdAt", "expiresAt", "id", "joined", "maxUses", "note", "revokedAt", "status", "uses"]);
  });
});

describe("revoking", () => {
  it("stops a code from being used, keeps the accounts made with it, and records it once", async () => {
    const alice = await makeAdmin("alice");
    config.registrationInviteOnly = true;
    const [invite] = (await post("/registration-invites", alice, await sudoOf(alice), { maxUses: 5 })).body.invites;
    expect((await register("carol", invite.code)).status).toBe(201);
    await prisma.auditLogEntry.deleteMany();

    const res = await post(`/registration-invites/${invite.id}/revoke`, alice, await sudoOf(alice));
    expect(res.status).toBe(200);
    expect(res.body.invite).toMatchObject({ id: invite.id, status: "revoked", joined: ["carol"] });
    expect(res.body.invite.revokedAt).not.toBeNull();
    expect((await register("dave", invite.code)).body.error).toBe("registration_invite_revoked");
    expect(await prisma.user.count({ where: { username: "carol" } })).toBe(1);

    const log = await entries();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: "registration_invite.revoke",
      source: "admin",
      actorUserId: alice.user.id,
      targetType: "registration_invite",
      targetId: invite.id,
      targetLabel: `…${invite.code.slice(-4)}`,
    });
    expect(JSON.stringify(log[0])).not.toContain(invite.code);

    // Doing it again changes nothing, so it is not recorded again.
    const again = await post(`/registration-invites/${invite.id}/revoke`, alice, await sudoOf(alice));
    expect(again.status).toBe(200);
    expect(again.body.invite.status).toBe("revoked");
    expect(await entries()).toHaveLength(1);
  });

  it("records it once when two revokes arrive together", async () => {
    const alice = await makeAdmin("alice");
    const invite = await prisma.registrationInvite.create({ data: { code: "ABCDEFGHJK" } });
    const sudo = await sudoOf(alice);
    const both = await Promise.all([post(`/registration-invites/${invite.id}/revoke`, alice, sudo), post(`/registration-invites/${invite.id}/revoke`, alice, sudo)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both.every((r) => r.body.invite.status === "revoked")).toBe(true);
    expect(await entries()).toHaveLength(1);
  });

  it("is a 404 for an invite that is not there, and takes the invite by id, never by code", async () => {
    const alice = await makeAdmin("alice");
    const invite = await prisma.registrationInvite.create({ data: { code: "ABCDEFGHJK" } });
    expect((await post("/registration-invites/not-an-invite/revoke", alice, await sudoOf(alice))).status).toBe(404);
    expect((await post(`/registration-invites/${invite.code}/revoke`, alice, await sudoOf(alice))).status).toBe(404);
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt).toBeNull();
    expect(await entries()).toHaveLength(0);
  });
});

describe("the command", () => {
  it("records what it makes and revokes as the operator's, from the command line, the same way the page does", async () => {
    const lines: string[] = [];
    const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    const settings = { registrationEnabled: true, registrationInviteOnly: true };
    expect(await runRegistrationInvitesCli(["create", "--note", "Alex"], prisma, out, settings)).toBe(0);
    const invite = await prisma.registrationInvite.findFirstOrThrow();
    expect(await runRegistrationInvitesCli(["revoke", invite.code], prisma, out, settings)).toBe(0);
    expect(await runRegistrationInvitesCli(["revoke", invite.code], prisma, out, settings)).toBe(0);

    const log = await entries();
    expect(log.map((e) => [e.action, e.source, e.actorLabel])).toEqual([
      ["registration_invite.create", "cli", "the operator (command line)"],
      ["registration_invite.revoke", "cli", "the operator (command line)"],
    ]);
    expect(log[0].details).toEqual({ maxUses: 1, days: 7, hasNote: true });
    expect(JSON.stringify(log)).not.toContain(invite.code);
  });
});
