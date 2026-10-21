// The users section of the admin page's API (#206): listing and looking at accounts, and the actions on them, which all need "sudo mode".
// What matters most is what it refuses: a write without a fresh proof, with someone else's, or with a token of another kind; an action on an
// admin account (only taking admin away is allowed from here); and anything that would show a secret.
import jwt from "jsonwebtoken";
import { generate } from "otplib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { SUDO_TTL_SECONDS, signSudoToken } from "../../src/lib/adminSudo.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { setAdmin } from "../../src/modules/admin/service.js";
import { purgeAccount } from "../../src/modules/users/deletion.js";
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

/** An admin the way the operator makes one, with two-factor sign-in on (which the page needs). */
async function makeAdmin(username: string): Promise<Admin> {
  const user = await registerUser(username, { password: PASSWORD });
  await setAdmin(username, true);
  const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(user.accessToken)).send({ password: PASSWORD })).body;
  expect((await api.post("/api/v1/auth/2fa/verify").set(authHeader(user.accessToken)).send({ code: await generate({ secret }) })).status).toBe(200);
  // Making them an admin is itself recorded (auditLog.test.ts covers it); these tests are about what is done afterwards.
  await prisma.auditLogEntry.deleteMany();
  return { ...user, secret };
}
const row = (user: Registered) => prisma.user.findUniqueOrThrow({ where: { protocolId: user.user.id } });
/** A code is good once per time step; tests that need several start each from a clean slate. */
async function sudoOf(admin: Admin): Promise<string> {
  await prisma.user.update({ where: { id: (await row(admin)).id }, data: { totpLastUsedStep: null } });
  const res = await api.post("/api/v1/admin/sudo").set(authHeader(admin.accessToken)).send({ password: PASSWORD, code: await generate({ secret: admin.secret }) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.sudoToken as string;
}
const call = (method: "get" | "post" | "put", path: string, as: Registered, sudo?: string, body?: object) => {
  const request = api[method](`/api/v1/admin${path}`).set(authHeader(as.accessToken));
  if (sudo) request.set("X-Admin-Sudo", sudo);
  return body ? request.send(body) : method === "get" ? request : request.send({});
};
const entries = () => prisma.auditLogEntry.findMany({ orderBy: { id: "asc" } });
const login = (username: string, password = PASSWORD) => api.post("/api/v1/auth/login").send({ username, password });

describe("sudo mode", () => {
  it("is given for the right password and a current code, and lasts ten minutes", async () => {
    const admin = await makeAdmin("alice");
    const before = Date.now();
    const res = await api.post("/api/v1/admin/sudo").set(authHeader(admin.accessToken)).send({ password: PASSWORD, code: await generate({ secret: admin.secret }) });
    expect(res.status).toBe(200);
    expect(typeof res.body.sudoToken).toBe("string");
    const expires = new Date(res.body.expiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + SUDO_TTL_SECONDS * 1000 - 2000);
    expect(expires).toBeLessThanOrEqual(Date.now() + SUDO_TTL_SECONDS * 1000 + 2000);
  });

  it("is refused for a wrong password, a wrong or missing code, and a code already used", async () => {
    const admin = await makeAdmin("alice");
    const code = await generate({ secret: admin.secret });
    const post = (body: object) => api.post("/api/v1/admin/sudo").set(authHeader(admin.accessToken)).send(body);
    expect((await post({ password: "Not-The-Password-1!", code })).status).toBe(401);
    expect((await post({ password: PASSWORD, code: "000000" })).body.error).toBe("invalid_code");
    expect((await post({ password: PASSWORD })).status).toBe(400);
    expect((await post({ code })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ password: PASSWORD, code })).status).toBe(200);
    const again = await post({ password: PASSWORD, code });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("invalid_code");
  });

  it("accepts a recovery code in place of one from the app", async () => {
    const user = await registerUser("alice", { password: PASSWORD });
    await setAdmin("alice", true);
    const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(user.accessToken)).send({ password: PASSWORD })).body;
    const verified = await api.post("/api/v1/auth/2fa/verify").set(authHeader(user.accessToken)).send({ code: await generate({ secret }) });
    const res = await api.post("/api/v1/admin/sudo").set(authHeader(user.accessToken)).send({ password: PASSWORD, recoveryCode: verified.body.recoveryCodes[0] });
    expect(res.status).toBe(200);
  });

  it("is not there for someone who is not an admin, and needs two-factor sign-in for one who is", async () => {
    const bob = await registerUser("bob", { password: PASSWORD });
    expect((await api.post("/api/v1/admin/sudo").set(authHeader(bob.accessToken)).send({ password: PASSWORD, code: "123456" })).status).toBe(404);
    expect((await api.post("/api/v1/admin/sudo").send({ password: PASSWORD, code: "123456" })).status).toBe(404);

    const bare = await registerUser("alice", { password: PASSWORD });
    await setAdmin("alice", true);
    const res = await api.post("/api/v1/admin/sudo").set(authHeader(bare.accessToken)).send({ password: PASSWORD, code: "123456" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("admin_requires_two_factor");
  });
});

/** Every request that changes something, with what it takes. */
const WRITES = [
  ["post", "/users/bob/suspend", undefined],
  ["post", "/users/bob/unsuspend", undefined],
  ["post", "/users/bob/reset-password", { password: "Brand-New-Passw0rd!" }],
  ["post", "/users/bob/disable-2fa", undefined],
  ["post", "/users/bob/delete", {}],
  ["post", "/users/bob/cancel-deletion", undefined],
  ["put", "/users/bob/admin", { admin: true }],
] as const;

describe("every action that changes something needs a sudo token", () => {
  it.each(WRITES)("%s %s without one", async (method, path, body) => {
    const admin = await makeAdmin("alice");
    const bob = await registerUser("bob");
    const res = await call(method, path, admin, undefined, body as object | undefined);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("sudo_required");
    // And nothing happened.
    const after = await row(bob);
    expect(after).toMatchObject({ suspendedAt: null, deletionRequestedAt: null, deletedAt: null, isAdmin: false });
    expect(await entries()).toEqual([]);
  });

  it("refuses a token that is garbage, expired, another admin's, or another kind of token", async () => {
    const alice = await makeAdmin("alice");
    const carol = await makeAdmin("carol");
    await registerUser("bob");
    const aliceRow = await row(alice);
    const tokens: Record<string, string> = {
      garbage: "not-a-token",
      expired: signSudoToken(config.jwtAccessSecret, aliceRow.id, new Date(Date.now() - 11 * 60 * 1000)).token,
      "another admin's": await sudoOf(carol),
      "an access token": alice.accessToken,
      "forged with the plain secret": jwt.sign({ purpose: "admin_sudo", sub: aliceRow.id }, config.jwtAccessSecret, { expiresIn: "10m" }),
    };
    for (const [name, token] of Object.entries(tokens)) {
      const res = await call("post", "/users/bob/suspend", alice, token);
      expect(res.status, name).toBe(403);
      expect(res.body.error, name).toBe("sudo_required");
    }
    expect((await prisma.user.findFirstOrThrow({ where: { username: "bob" } })).suspendedAt).toBeNull();
  });

  it("is not needed to look: the list and an account's details answer without it", async () => {
    const admin = await makeAdmin("alice");
    await registerUser("bob");
    expect((await call("get", "/users", admin)).status).toBe(200);
    expect((await call("get", "/users/bob", admin)).status).toBe(200);
  });

  it("is checked before anything else, so a missing account is not told apart from one that exists", async () => {
    const admin = await makeAdmin("alice");
    expect((await call("post", "/users/nobody/suspend", admin)).status).toBe(403);
  });
});

describe("the list and the details", () => {
  it("lists the accounts here, oldest first, with what an admin needs and no secret", async () => {
    const admin = await makeAdmin("alice");
    await registerUser("bob", { displayName: "Bob B" });
    const res = await call("get", "/users", admin);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.users.map((u: { username: string }) => u.username)).toEqual(["alice", "bob"]);
    expect(res.body.users[1]).toEqual({
      id: expect.any(String),
      username: "bob",
      identity: `@bob:${config.domain}`,
      displayName: "Bob B",
      createdAt: expect.any(String),
      lastSeenAt: null,
      twoFactor: false,
      suspended: false,
      admin: false,
      deletionPending: false,
      communitiesOwned: 0,
      communitiesJoined: 0,
    });
    expect(res.body.users[0]).toMatchObject({ username: "alice", admin: true, twoFactor: true });
  });

  it("leaves out the cached copies of other servers' people and accounts that were erased", async () => {
    const admin = await makeAdmin("alice");
    const gone = await registerUser("gone");
    await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: "far.example", isRemote: true } });
    expect((await purgeAccount((await row(gone)).id)).ok).toBe(true);
    const res = await call("get", "/users", admin);
    expect(res.body.users.map((u: { username: string }) => u.username)).toEqual(["alice"]);
    expect(res.body.total).toBe(1);
    expect((await call("get", "/users/remy", admin)).status).toBe(404);
    expect((await call("get", "/users/gone", admin)).status).toBe(404);
  });

  it("searches by username or name, and filters to the suspended, or to admins", async () => {
    const admin = await makeAdmin("alice");
    await registerUser("bob", { displayName: "Robert" });
    await registerUser("carol", { displayName: "Carol" });
    await prisma.user.update({ where: { username_homeserverDomain: { username: "carol", homeserverDomain: config.domain } }, data: { suspendedAt: new Date() } });
    const names = async (query: string) => (await call("get", `/users${query}`, admin)).body.users.map((u: { username: string }) => u.username);
    expect(await names("?search=rob")).toEqual(["bob"]);
    expect(await names("?search=BOB")).toEqual(["bob"]);
    expect(await names("?suspended=1")).toEqual(["carol"]);
    expect(await names("?admin=true")).toEqual(["alice"]);
    expect(await names("?admin=0")).toEqual(["bob", "carol"]);
    expect(await names("?search=nobody")).toEqual([]);
  });

  it("matches what was typed literally: a % or _ is not a wildcard", async () => {
    const admin = await makeAdmin("alice");
    await registerUser("bob");
    expect((await call("get", "/users?search=%25", admin)).body.users).toEqual([]);
    expect((await call("get", "/users?search=b_b", admin)).body.users).toEqual([]);
  });

  it("pages, and says how many there are in all", async () => {
    const admin = await makeAdmin("alice");
    for (const name of ["bob", "carol", "dave", "erin"]) await registerUser(name);
    const first = await call("get", "/users?limit=2", admin);
    expect(first.body.users.map((u: { username: string }) => u.username)).toEqual(["alice", "bob"]);
    expect(first.body.total).toBe(5);
    const last = await call("get", "/users?limit=2&offset=4", admin);
    expect(last.body.users.map((u: { username: string }) => u.username)).toEqual(["erin"]);
    expect((await call("get", "/users?limit=2&offset=40", admin)).body.users).toEqual([]);
  });

  it("refuses a query that is not one", async () => {
    const admin = await makeAdmin("alice");
    for (const query of ["?limit=0", "?limit=101", "?limit=x", "?offset=-1", "?suspended=maybe", "?search=" + "x".repeat(101)]) {
      expect((await call("get", `/users${query}`, admin)).status, query).toBe(400);
    }
  });

  it("shows one account: what an admin can act on, and never a password hash, 2FA secret, recovery code or token", async () => {
    const admin = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const owned = await api.post("/api/v1/communities").set(authHeader(bob.accessToken)).send({ name: "Bob's Club" });
    const bobRow = await row(bob);
    const withSecrets = await prisma.user.update({ where: { id: bobRow.id }, data: { totpSecret: "SUPERSECRETTOTPSEED" } });

    const res = await call("get", "/users/bob", admin);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      username: "bob",
      admin: false,
      suspendedAt: null,
      deletionRequestedAt: null,
      deletionScheduledFor: null,
      activeSessions: 1,
      ownedCommunities: [{ id: owned.body.community.id, name: "Bob's Club" }],
      registrationInviteNote: null,
    });
    const text = JSON.stringify(res.body);
    for (const secret of [withSecrets.passwordHash!, "SUPERSECRETTOTPSEED", bob.refreshToken, bob.accessToken]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/passwordHash|totpSecret|tokenHash|recoveryCode/i);
  });

  it("is for admins with two-factor sign-in only, the list and an account's details alike", async () => {
    const bob = await registerUser("bob");
    expect((await call("get", "/users", bob)).status).toBe(404);
    expect((await call("get", "/users/bob", bob)).status).toBe(404);
    const bare = await registerUser("alice");
    await setAdmin("alice", true);
    for (const path of ["/users", "/users/bob", "/audit-log"]) {
      const res = await call("get", path, bare);
      expect(res.status, path).toBe(403);
      expect(res.body.error, path).toBe("admin_requires_two_factor");
    }
  });

  it("never gives more than a page of 100 at a time, whatever the service is asked for", async () => {
    const { listUsersPage, MAX_USER_PAGE } = await import("../../src/modules/admin/service.js");
    await prisma.user.createMany({
      data: Array.from({ length: MAX_USER_PAGE + 5 }, (_, i) => ({ protocolId: newProtocolId(), username: `user_${i}`, displayName: `User ${i}`, homeserverDomain: config.domain })),
    });
    const page = await listUsersPage({ limit: 100_000 });
    expect(page.users).toHaveLength(MAX_USER_PAGE);
    expect(page.total).toBe(MAX_USER_PAGE + 5);
    expect((await listUsersPage({ limit: 0 })).users).toHaveLength(25);
    expect((await listUsersPage({ limit: -3, offset: -7 })).users).toHaveLength(25);
  });
});

describe("the actions, with sudo", () => {
  it("suspending stops sign-in and ends the sessions, and is recorded as the admin's, from the page", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const res = await call("post", "/users/bob/suspend", alice, await sudoOf(alice));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "bob", suspended: true });
    expect((await login("bob")).status).toBe(403);
    expect((await api.post("/api/v1/auth/refresh").send({ refreshToken: bob.refreshToken })).status).toBe(401);

    const [entry] = await entries();
    expect(entry).toMatchObject({ source: "admin", action: "user.suspend", actorUserId: alice.user.id, actorLabel: expect.stringMatching(/^@alice:/), targetId: bob.user.id });
  });

  it("unsuspending lets them in again", async () => {
    const alice = await makeAdmin("alice");
    await registerUser("bob", { password: PASSWORD });
    await call("post", "/users/bob/suspend", alice, await sudoOf(alice));
    const res = await call("post", "/users/bob/unsuspend", alice, await sudoOf(alice));
    expect(res.body.user.suspended).toBe(false);
    expect((await login("bob")).status).toBe(200);
    expect((await entries()).map((e) => e.action)).toEqual(["user.suspend", "user.unsuspend"]);
  });

  it("resetting a password sets the new one, ends the sessions, holds it to the sign-up rules, and never records it", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const sudo = await sudoOf(alice);

    const weak = await call("post", "/users/bob/reset-password", alice, sudo, { password: "short" });
    expect(weak.status).toBe(400);
    expect((await login("bob")).status).toBe(200); // unchanged

    const res = await call("post", "/users/bob/reset-password", alice, sudo, { password: "Brand-New-Passw0rd!" });
    expect(res.status).toBe(200);
    expect((await login("bob")).status).toBe(401);
    expect((await login("bob", "Brand-New-Passw0rd!")).status).toBe(200);
    expect((await api.post("/api/v1/auth/refresh").send({ refreshToken: bob.refreshToken })).status).toBe(401);
    expect(JSON.stringify(await entries())).not.toContain("Brand-New-Passw0rd");
    expect((await entries()).map((e) => e.action)).toEqual(["user.reset_password"]);
  });

  it("turning off two-factor sign-in removes it and its codes", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(bob.accessToken)).send({ password: PASSWORD })).body;
    await api.post("/api/v1/auth/2fa/verify").set(authHeader(bob.accessToken)).send({ code: await generate({ secret }) });
    expect((await row(bob)).totpEnabled).toBe(true);

    const res = await call("post", "/users/bob/disable-2fa", alice, await sudoOf(alice));
    expect(res.body.user.twoFactor).toBe(false);
    expect((await login("bob")).body.totpRequired).toBeUndefined();
    expect(await prisma.totpRecoveryCode.count({ where: { userId: (await row(bob)).id } })).toBe(0);
  });

  it("deleting asks for it as the person could: sessions end, a date is set, and signing in cancels it", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const res = await call("post", "/users/bob/delete", alice, await sudoOf(alice), {});
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ deletionRequestedAt: expect.any(String), deletionScheduledFor: expect.any(String) });
    expect((await row(bob)).deletedAt).toBeNull();
    expect((await api.post("/api/v1/auth/refresh").send({ refreshToken: bob.refreshToken })).status).toBe(401);
    expect((await login("bob")).body.deletionCancelled).toBe(true);
  });

  it("cancelling takes a pending deletion back without them signing in", async () => {
    const alice = await makeAdmin("alice");
    await registerUser("bob");
    await call("post", "/users/bob/delete", alice, await sudoOf(alice), {});
    const res = await call("post", "/users/bob/cancel-deletion", alice, await sudoOf(alice));
    expect(res.body.user).toMatchObject({ deletionRequestedAt: null, deletionScheduledFor: null, deletionPending: false });
    expect((await entries()).map((e) => e.action)).toEqual(["account.delete_request", "account.delete_cancel"]);
  });

  it("erasing at once needs the username typed out, and then cannot be undone", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    const sudo = await sudoOf(alice);
    for (const confirm of [undefined, "", "bobby", "alice"]) {
      const res = await call("post", "/users/bob/delete", alice, sudo, { now: true, ...(confirm === undefined ? {} : { confirm }) });
      expect(res.status, String(confirm)).toBe(400);
      expect(res.body.error).toBe("confirm_mismatch");
    }
    expect((await row(bob)).deletedAt).toBeNull();

    const res = await call("post", "/users/bob/delete", alice, sudo, { now: true, confirm: " BOB " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ erased: true });
    expect((await row(bob)).deletedAt).not.toBeNull();
    expect((await login("bob")).status).toBe(401);
    expect((await call("get", "/users/bob", alice)).status).toBe(404);
    expect((await entries()).at(-1)).toMatchObject({ action: "account.erase", source: "admin", actorUserId: alice.user.id });
  });

  it("will not delete someone who owns a community, and says which", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob");
    const club = (await api.post("/api/v1/communities").set(authHeader(bob.accessToken)).send({ name: "Bob's Club" })).body.community;
    for (const body of [{}, { now: true, confirm: "bob" }]) {
      const res = await call("post", "/users/bob/delete", alice, await sudoOf(alice), body);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "owns_communities", communities: [{ id: club.id, name: "Bob's Club" }] });
    }
    const after = await row(bob);
    expect(after.deletionRequestedAt).toBeNull();
    expect(after.deletedAt).toBeNull();
  });

  it("does not know an account that is not here, whatever it is asked to do", async () => {
    const alice = await makeAdmin("alice");
    await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: "far.example", isRemote: true } });
    for (const [method, path, body] of WRITES) {
      const name = path.replace("/bob/", "/nobody/");
      expect((await call(method, name, alice, await sudoOf(alice), body as object | undefined)).status, name).toBe(404);
      expect((await call(method, path.replace("/bob/", "/remy/"), alice, await sudoOf(alice), body as object | undefined)).status, `remy ${path}`).toBe(404);
    }
    expect(await entries()).toEqual([]);
  });
});

describe("an admin account", () => {
  const ACTIONS_ON_AN_ADMIN = WRITES.filter(([, path]) => !path.endsWith("/admin"));

  it.each(ACTIONS_ON_AN_ADMIN)("cannot be changed from the page: %s %s (only taking admin away can)", async (method, path, body) => {
    const alice = await makeAdmin("alice");
    const carol = await makeAdmin("carol");
    const target = path.replace("/bob/", "/carol/");
    const res = await call(method, target, alice, await sudoOf(alice), body as object | undefined);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("target_is_admin");
    expect(await row(carol)).toMatchObject({ suspendedAt: null, deletionRequestedAt: null, deletedAt: null, totpEnabled: true, isAdmin: true });
    expect(await entries()).toEqual([]);
  });

  it("cannot be done to yourself either: that is the same rule", async () => {
    const alice = await makeAdmin("alice");
    for (const path of ["suspend", "delete", "disable-2fa", "reset-password"]) {
      const res = await call("post", `/users/alice/${path}`, alice, await sudoOf(alice), path === "reset-password" ? { password: "Brand-New-Passw0rd!" } : {});
      expect(res.status, path).toBe(409);
    }
    expect((await row(alice)).suspendedAt).toBeNull();
  });

  it("is made by an admin passing it on, who then has to turn on two-factor sign-in to use it", async () => {
    const alice = await makeAdmin("alice");
    const bob = await registerUser("bob", { password: PASSWORD });
    expect((await call("get", "/me", bob)).status).toBe(404);

    const res = await call("put", "/users/bob/admin", alice, await sudoOf(alice), { admin: true });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "bob", admin: true, twoFactor: false });
    const me = await call("get", "/me", bob);
    expect(me.body).toEqual({ admin: true, twoFactor: false });
    expect((await call("get", "/users", bob)).status).toBe(403);
    expect(await entries()).toMatchObject([{ action: "user.admin_grant", source: "admin", actorUserId: alice.user.id, targetId: bob.user.id }]);
  });

  it("is taken away at once, with the same session, and the account can then be managed like any other", async () => {
    const alice = await makeAdmin("alice");
    const carol = await makeAdmin("carol");
    expect((await call("get", "/users", carol)).status).toBe(200);

    const res = await call("put", "/users/carol/admin", alice, await sudoOf(alice), { admin: false });
    expect(res.body.user.admin).toBe(false);
    expect((await call("get", "/users", carol)).status).toBe(404);
    expect((await call("post", "/users/carol/suspend", alice, await sudoOf(alice))).status).toBe(200);
    expect((await entries()).map((e) => e.action)).toEqual(["user.admin_revoke", "user.suspend"]);
  });

  it("is never taken from yourself, which also means the last admin cannot be removed from here", async () => {
    const alice = await makeAdmin("alice");
    for (const admin of [false, true]) {
      const res = await call("put", "/users/alice/admin", alice, await sudoOf(alice), { admin });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("cannot_change_own_admin");
    }
    expect((await row(alice)).isAdmin).toBe(true);
    expect(await entries()).toEqual([]);
  });

  it("is not given to someone who is suspended, and giving or taking it twice changes nothing more", async () => {
    const alice = await makeAdmin("alice");
    await registerUser("bob");
    await registerUser("carol");
    await prisma.user.update({ where: { username_homeserverDomain: { username: "carol", homeserverDomain: config.domain } }, data: { suspendedAt: new Date() } });
    expect((await call("put", "/users/carol/admin", alice, await sudoOf(alice), { admin: true })).body.error).toBe("target_suspended");

    await call("put", "/users/bob/admin", alice, await sudoOf(alice), { admin: true });
    await call("put", "/users/bob/admin", alice, await sudoOf(alice), { admin: true });
    await call("put", "/users/bob/admin", alice, await sudoOf(alice), { admin: false });
    await call("put", "/users/bob/admin", alice, await sudoOf(alice), { admin: false });
    expect((await entries()).map((e) => e.action)).toEqual(["user.admin_grant", "user.admin_revoke"]);
  });

  it("refuses a body that is not one, and only the one flag", async () => {
    const alice = await makeAdmin("alice");
    await registerUser("bob");
    for (const body of [{}, { admin: "yes" }, { admin: 1 }, { isAdmin: true }]) {
      expect((await call("put", "/users/bob/admin", alice, await sudoOf(alice), body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("the switch", () => {
  it("takes all of it away: with ADMIN_ENABLED=false even a valid sudo token gets nothing", async () => {
    const alice = await makeAdmin("alice");
    await registerUser("bob");
    const sudo = await sudoOf(alice);
    config.adminEnabled = false;
    expect((await call("get", "/users", alice)).status).toBe(404);
    expect((await call("post", "/users/bob/suspend", alice, sudo)).status).toBe(404);
    expect((await api.post("/api/v1/admin/sudo").set(authHeader(alice.accessToken)).send({ password: PASSWORD, code: "123456" })).status).toBe(404);
    expect((await prisma.user.findFirstOrThrow({ where: { username: "bob" } })).suspendedAt).toBeNull();
  });
});

describe("a search for a wildcard finds nothing, wherever people can search", () => {
  it("in the app's own people search and in the admin command's list", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    await registerUser("carol");
    // These used to match everyone: `contains` passes % and _ to LIKE as they are.
    for (const q of ["%25%25", "__", "%25_"]) {
      expect((await api.get(`/api/v1/users/search?q=${q}`).set(authHeader(alice.accessToken))).body.users, q).toEqual([]);
    }
    const { listUsers } = await import("../../src/modules/admin/service.js");
    expect(await listUsers({ search: "%" })).toEqual([]);
    expect(await listUsers({ search: "b_b" })).toEqual([]);
    expect((await listUsers({ search: "bo" })).map((u) => u.username)).toEqual(["bob"]);
    expect((await api.get("/api/v1/users/search?q=bo").set(authHeader(alice.accessToken))).body.users.map((u: { username: string }) => u.username)).toEqual(["bob"]);
  });
});

