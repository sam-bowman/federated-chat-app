// Invite-only registration (REGISTRATION_INVITE_ONLY): an account needs a code the operator made with the command line.
//
// config.registrationInviteOnly / registrationEnabled are read at the moment of each request, so these tests flip them per
// test and put them back.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { generateInviteCode } from "../../src/lib/registrationInvites.js";
import { checkRegistrationInvite, createAccount, registrationRefusalStatus } from "../../src/modules/auth/registrationInviteService.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

beforeEach(resetDb);
afterAll(disconnectDb);
afterEach(() => {
  config.registrationEnabled = true;
  config.registrationInviteOnly = false;
});

const PASSWORD = "Str0ng!Passw0rd";
const register = (username: string, inviteCode?: string) =>
  api.post("/api/v1/auth/register").send({ username, password: PASSWORD, ...(inviteCode === undefined ? {} : { inviteCode }) });

async function makeInvite(data: { maxUses?: number | null; expiresAt?: Date | null; revokedAt?: Date | null; uses?: number; note?: string } = {}) {
  return prisma.registrationInvite.create({
    data: { code: generateInviteCode(), maxUses: data.maxUses === undefined ? 1 : data.maxUses, expiresAt: data.expiresAt ?? null, revokedAt: data.revokedAt ?? null, uses: data.uses ?? 0, note: data.note },
  });
}

const HOUR = 3_600_000;

describe("a server that is not invite-only", () => {
  it("lets anyone register without a code", async () => {
    expect((await register("alice")).status).toBe(201);
  });

  it("does not use up a code that is sent anyway, and does not tie the account to it", async () => {
    const invite = await makeInvite();
    const res = await register("alice", invite.code);
    expect(res.status).toBe(201);
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).uses).toBe(0);
    expect((await prisma.user.findFirstOrThrow({ where: { username: "alice" } })).registrationInviteId).toBeNull();
  });
});

describe("a server that is invite-only", () => {
  beforeEach(() => {
    config.registrationInviteOnly = true;
  });

  it("asks for a code, and makes no account without one", async () => {
    for (const body of [undefined, "", "   "]) {
      const res = await register("alice", body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body.error).toBe("registration_invite_required");
    }
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a code that does not exist", async () => {
    const res = await register("alice", "NOSUCHCODE");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("registration_invite_invalid");
    expect(await prisma.user.count()).toBe(0);
  });

  it("makes the account with a good code, uses it up and remembers which one the account came from", async () => {
    const invite = await makeInvite({ maxUses: 3, note: "Alex" });
    const res = await register("alice", invite.code);
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    const fresh = await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(fresh.uses).toBe(1);
    const alice = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    expect(alice.registrationInviteId).toBe(invite.id);
  });

  it("reads the code in any case and ignores spaces around it", async () => {
    const invite = await makeInvite();
    expect((await register("alice", `  ${invite.code.toLowerCase()} `)).status).toBe(201);
  });

  it("lets a single-use code make exactly one account", async () => {
    const invite = await makeInvite({ maxUses: 1 });
    expect((await register("alice", invite.code)).status).toBe(201);
    const second = await register("bob", invite.code);
    expect(second.status).toBe(403);
    expect(second.body.error).toBe("registration_invite_used_up");
    expect(await prisma.user.count()).toBe(1);
  });

  it("lets a code with several uses make that many, and an unlimited one any number", async () => {
    const two = await makeInvite({ maxUses: 2 });
    expect((await register("one", two.code)).status).toBe(201);
    expect((await register("two", two.code)).status).toBe(201);
    expect((await register("three", two.code)).body.error).toBe("registration_invite_used_up");

    const unlimited = await makeInvite({ maxUses: null });
    for (const name of ["u_a", "u_b", "u_c", "u_d"]) expect((await register(name, unlimited.code)).status).toBe(201);
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: unlimited.id } })).uses).toBe(4);
  });

  it("says a code has expired, and a code that has not yet expired still works", async () => {
    const old = await makeInvite({ expiresAt: new Date(Date.now() - HOUR) });
    const expired = await register("alice", old.code);
    expect(expired.status).toBe(403);
    expect(expired.body.error).toBe("registration_invite_expired");

    const fresh = await makeInvite({ expiresAt: new Date(Date.now() + HOUR) });
    expect((await register("alice", fresh.code)).status).toBe(201);
  });

  it("says a code has been revoked, even if it has also expired", async () => {
    const revoked = await makeInvite({ revokedAt: new Date() });
    const res = await register("alice", revoked.code);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("registration_invite_revoked");

    const both = await makeInvite({ revokedAt: new Date(), expiresAt: new Date(Date.now() - HOUR) });
    expect((await register("alice", both.code)).body.error).toBe("registration_invite_revoked");
  });

  it("does not use up a code on a registration that fails, so the person can try again", async () => {
    const first = await makeInvite();
    expect((await register("alice", first.code)).status).toBe(201);

    const second = await makeInvite();
    const taken = await register("alice", second.code);
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("username_taken");
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: second.id } })).uses).toBe(0);

    const weak = await api.post("/api/v1/auth/register").send({ username: "carol", password: "weak", inviteCode: second.code });
    expect(weak.status).toBe(400);
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: second.id } })).uses).toBe(0);

    expect((await register("bob", second.code)).status).toBe(201);
  });

  it("judges the code before anything else, so nobody without one can find out which usernames are taken", async () => {
    const invite = await makeInvite();
    expect((await register("alice", invite.code)).status).toBe(201);
    const without = await register("alice");
    expect(without.status).toBe(403);
    expect(without.body.error).toBe("registration_invite_required");
    const wrong = await register("alice", "NOSUCHCODE");
    expect(wrong.body.error).toBe("registration_invite_invalid");

    // A code that no longer works is judged first too: the answer is about the code, not about the username.
    const revoked = await makeInvite({ revokedAt: new Date() });
    expect((await register("alice", revoked.code)).body.error).toBe("registration_invite_revoked");
    const expired = await makeInvite({ expiresAt: new Date(Date.now() - HOUR) });
    expect((await register("alice", expired.code)).body.error).toBe("registration_invite_expired");
    const spent = await makeInvite({ uses: 1 });
    expect((await register("alice", spent.code)).body.error).toBe("registration_invite_used_up");
  });

  it("leaves the code unspent for the loser when two people ask for the same username at the same moment", async () => {
    const a = await makeInvite();
    const b = await makeInvite();
    const results = await Promise.all([register("same", a.code), register("same", b.code)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const lost = results.find((r) => r.status === 409)!;
    expect(lost.body.error).toBe("username_taken");
    expect(await prisma.user.count({ where: { username: "same" } })).toBe(1);

    const uses = (await prisma.registrationInvite.findMany()).map((i) => i.uses).sort();
    expect(uses).toEqual([0, 1]);
  });

  it("gives the last use to only one of several people asking at the same moment", async () => {
    const invite = await makeInvite({ maxUses: 1 });
    const results = await Promise.all(["r_a", "r_b", "r_c", "r_d", "r_e"].map((name) => register(name, invite.code)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const lost of results.filter((r) => r.status !== 201)) {
      expect(lost.status).toBe(403);
      expect(lost.body.error).toBe("registration_invite_used_up");
    }
    expect(await prisma.user.count()).toBe(1);
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).uses).toBe(1);
  });

  it("keeps people who are already in able to sign in", async () => {
    config.registrationInviteOnly = false;
    expect((await register("alice")).status).toBe(201);
    config.registrationInviteOnly = true;
    const login = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it("keeps the accounts a code made when the code is revoked or deleted", async () => {
    const invite = await makeInvite({ maxUses: 2 });
    expect((await register("alice", invite.code)).status).toBe(201);
    await prisma.registrationInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
    expect(await prisma.user.count({ where: { username: "alice" } })).toBe(1);

    await prisma.registrationInvite.delete({ where: { id: invite.id } });
    const alice = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    expect(alice.registrationInviteId).toBeNull();
  });

  it("is still closed when registration is off altogether, code or not", async () => {
    const invite = await makeInvite();
    config.registrationEnabled = false;
    const res = await register("alice", invite.code);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("registration_disabled");
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).uses).toBe(0);
  });
});

describe("claiming a code between checking it and making the account", () => {
  const userData = (username: string) => ({
    protocolId: `01TESTPROTOCOLID${username}`.padEnd(26, "0").slice(0, 26),
    username,
    passwordHash: "x",
    displayName: username,
    homeserverDomain: config.domain,
  });

  it("is refused with the reason, and no account is made, if the code stopped working in between", async () => {
    const invite = await makeInvite({ maxUses: 1 });
    const checked = await checkRegistrationInvite(invite.code);
    if (!checked.ok) throw new Error("should have been usable");

    await prisma.registrationInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
    const revoked = await createAccount(userData("alice"), checked.invite);
    expect(revoked).toEqual({ ok: false, error: "registration_invite_revoked" });

    await prisma.registrationInvite.update({ where: { id: invite.id }, data: { revokedAt: null, uses: 1 } });
    const usedUp = await createAccount(userData("alice"), checked.invite);
    expect(usedUp).toEqual({ ok: false, error: "registration_invite_used_up" });

    await prisma.registrationInvite.update({ where: { id: invite.id }, data: { uses: 0, expiresAt: new Date(Date.now() - HOUR) } });
    const expired = await createAccount(userData("alice"), checked.invite);
    expect(expired).toEqual({ ok: false, error: "registration_invite_expired" });

    expect(await prisma.user.count()).toBe(0);
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).uses).toBe(0);
  });

  it("is refused, with the code unspent and no second account, if the username was taken in between", async () => {
    const invite = await makeInvite({ maxUses: 1 });
    const checked = await checkRegistrationInvite(invite.code);
    if (!checked.ok) throw new Error("should have been usable");

    expect((await createAccount(userData("same"), null)).ok).toBe(true);
    const lost = await createAccount({ ...userData("same"), protocolId: "01TESTPROTOCOLIDOTHER00000" }, checked.invite);
    expect(lost).toEqual({ ok: false, error: "username_taken" });
    expect(await prisma.user.count({ where: { username: "same" } })).toBe(1);
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).uses).toBe(0);

    // And without a code at all: the same answer rather than an error.
    expect(await createAccount({ ...userData("same"), protocolId: "01TESTPROTOCOLIDOTHER00001" }, null)).toEqual({ ok: false, error: "username_taken" });
  });

  it("answers a taken username with a conflict and any problem with the code with forbidden", () => {
    expect(registrationRefusalStatus("username_taken")).toBe(409);
    for (const error of ["registration_invite_required", "registration_invite_invalid", "registration_invite_revoked", "registration_invite_expired", "registration_invite_used_up"] as const) {
      expect(registrationRefusalStatus(error)).toBe(403);
    }
  });

  it("is refused as revoked if the code was deleted in between", async () => {
    const invite = await makeInvite();
    const checked = await checkRegistrationInvite(invite.code);
    if (!checked.ok) throw new Error("should have been usable");
    await prisma.registrationInvite.delete({ where: { id: invite.id } });
    expect(await createAccount(userData("alice"), checked.invite)).toEqual({ ok: false, error: "registration_invite_revoked" });
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("the discovery document", () => {
  it("says whether a code is needed", async () => {
    expect((await api.get("/.well-known/communication-platform")).body.registration).toEqual({ enabled: true, inviteOnly: false });
    config.registrationInviteOnly = true;
    expect((await api.get("/.well-known/communication-platform")).body.registration).toEqual({ enabled: true, inviteOnly: true });
  });

  it("does not claim a code is needed when nobody can register at all", async () => {
    config.registrationInviteOnly = true;
    config.registrationEnabled = false;
    expect((await api.get("/.well-known/communication-platform")).body.registration).toEqual({ enabled: false, inviteOnly: false });
  });
});
