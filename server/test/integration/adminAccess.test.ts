// Who can reach the admin API (#206), and what it must NOT tell anyone else: that it is there. Everything under /api/v1/admin answers 404
// (the very answer a path that does not exist gives) to a signed-out visitor, a wrong token and an ordinary account; an admin is looked up
// on every request, so taking the flag away, suspending or erasing the account ends the access at once; and the flag can only come from
// the operator's command.
import { generate } from "otplib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
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

/** An admin the way the operator makes one: through the command's own service function. */
async function makeAdmin(username: string, withTwoFactor = true) {
  const user = await registerUser(username, { password: PASSWORD });
  expect((await setAdmin(username, true)).ok).toBe(true);
  if (withTwoFactor) {
    const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(user.accessToken)).send({ password: PASSWORD })).body;
    expect((await api.post("/api/v1/auth/2fa/verify").set(authHeader(user.accessToken)).send({ code: await generate({ secret }) })).status).toBe(200);
  }
  return user;
}
const get = (path: string, user?: Registered) => {
  const request = api.get(`/api/v1${path}`);
  return user ? request.set(authHeader(user.accessToken)) : request;
};
const row = (user: Registered) => prisma.user.findUniqueOrThrow({ where: { protocolId: user.user.id } });

describe("a server with no admin", () => {
  it("shows nothing: every admin path answers exactly as a path that does not exist", async () => {
    const alice = await registerUser("alice");
    const missing = await get("/admin-does-not-exist", alice);
    expect(missing.status).toBe(404);

    for (const path of ["/admin/me", "/admin/audit-log", "/admin/anything-at-all"]) {
      for (const who of [undefined, alice]) {
        const res = await get(path, who);
        expect(res.status, `${path} ${who ? "signed in" : "signed out"}`).toBe(404);
        expect(res.body).toEqual(missing.body);
        expect(res.body).toEqual({ error: "not_found" });
      }
    }
  });

  it("is the same for a made-up token and for a malformed header", async () => {
    await registerUser("alice");
    expect((await api.get("/api/v1/admin/me").set("Authorization", "Bearer not.a.token")).status).toBe(404);
    expect((await api.get("/api/v1/admin/me").set("Authorization", "Basic abc")).status).toBe(404);
    expect((await api.post("/api/v1/admin/audit-log").set("Authorization", "Bearer x").send({})).status).toBe(404);
  });

  it("is not made an admin by asking: nothing in the API takes the flag", async () => {
    const created = await api.post("/api/v1/auth/register").send({ username: "mallory", password: PASSWORD, isAdmin: true, admin: true });
    expect(created.status).toBe(201);
    const mallory = created.body as Registered;
    await api.patch("/api/v1/users/me").set(authHeader(mallory.accessToken)).send({ isAdmin: true, admin: true });
    expect((await row(mallory)).isAdmin).toBe(false);
    expect((await get("/admin/me", mallory)).status).toBe(404);
  });
});

describe("an admin", () => {
  it("gets in, and is told whether two-factor sign-in is on", async () => {
    const bare = await makeAdmin("alice", false);
    const me = await get("/admin/me", bare);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ admin: true, twoFactor: false });

    const safe = await makeAdmin("bella", true);
    expect((await get("/admin/me", safe)).body).toEqual({ admin: true, twoFactor: true });
  });

  it("is held to two-factor sign-in for everything else, and told why", async () => {
    const bare = await makeAdmin("alice", false);
    const res = await get("/admin/audit-log", bare);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("admin_requires_two_factor");
    expect((await get("/admin/audit-log", await makeAdmin("bella", true))).status).toBe(200);
  });

  it("loses access at once when the flag is taken away, though the token is still good", async () => {
    const admin = await makeAdmin("alice");
    expect((await get("/admin/audit-log", admin)).status).toBe(200);
    await setAdmin("alice", false);
    expect((await get("/admin/audit-log", admin)).status).toBe(404);
    expect((await get("/admin/me", admin)).status).toBe(404);
  });

  it("loses access when suspended, and when erased", async () => {
    const suspended = await makeAdmin("alice");
    await prisma.user.update({ where: { id: (await row(suspended)).id }, data: { suspendedAt: new Date() } });
    expect((await get("/admin/me", suspended)).status).toBe(404);

    const erased = await makeAdmin("bella");
    expect((await purgeAccount((await row(erased)).id)).ok).toBe(true);
    expect((await get("/admin/me", erased)).status).toBe(404);
  });

  it("is switched off entirely by ADMIN_ENABLED=false, even for an admin", async () => {
    const admin = await makeAdmin("alice");
    config.adminEnabled = false;
    expect((await get("/admin/me", admin)).status).toBe(404);
    expect((await get("/admin/audit-log", admin)).status).toBe(404);
    // The app is told too, so it does not offer a way in.
    expect((await get("/users/me", admin)).body.user.isAdmin).toBe(false);
    config.adminEnabled = true;
    expect((await get("/users/me", admin)).body.user.isAdmin).toBe(true);
  });

  it("is told it is one, and nobody else is", async () => {
    const admin = await makeAdmin("alice");
    const bob = await registerUser("bob");
    expect((await get("/users/me", admin)).body.user.isAdmin).toBe(true);
    expect((await get("/users/me", bob)).body.user.isAdmin).toBe(false);
    // Another person looking at the admin sees nothing of it, in a profile or a lookup.
    expect((await get("/users/alice", bob)).body.user).not.toHaveProperty("isAdmin");
    expect((await get(`/users/${admin.user.id}/profile`, bob)).body.profile.user).not.toHaveProperty("isAdmin");
  });

  it("is only an admin on the server it was made one on: a cached copy of someone else's account is never one", async () => {
    const remote = await prisma.user.create({ data: { protocolId: "01REMOTEADMIN", username: "remy", displayName: "Remy", homeserverDomain: "far.example", isRemote: true, isAdmin: true } });
    expect(remote.isAdmin).toBe(true);
    expect((await setAdmin("remy", true)).ok).toBe(false);
  });
});
