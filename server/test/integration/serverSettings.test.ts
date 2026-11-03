// Server settings on the admin page (#206, phase 4): what an admin can change without a restart, and the rules that keep it safe. A value set in
// the environment is locked; what is stored is held to the same strict parsers the environment is; a change takes effect at once; and a change
// made by another replica (a row in the table) is picked up. The point of each test is a way this could go wrong quietly: a typo reading as "off",
// a locked value overwritten, a setting that does nothing.
import { generate } from "otplib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, settingsEnvironment } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { setAdmin } from "../../src/modules/admin/service.js";
import { loadServerSettings, startServerSettingsSync } from "../../src/modules/settings/service.js";
import { SETTING_KEYS } from "../../src/lib/serverSettings.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

// The environment the tests run in sets a couple of these; the tests decide for themselves which are locked.
const realEnvironment = { ...settingsEnvironment };
beforeEach(async () => {
  await resetDb();
  for (const key of SETTING_KEYS) settingsEnvironment[key] = undefined;
  await loadServerSettings();
});
afterEach(async () => {
  await prisma.serverSetting.deleteMany();
  await loadServerSettings();
  Object.assign(settingsEnvironment, realEnvironment);
  config.adminEnabled = true;
  config.registrationEnabled = true;
  config.serverName = "Test Server";
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
const list = (as: Registered) => api.get("/api/v1/admin/settings").set(authHeader(as.accessToken));
const put = (key: string, value: string, as: Registered, sudo: string) =>
  api.put(`/api/v1/admin/settings/${key}`).set(authHeader(as.accessToken)).set("X-Admin-Sudo", sudo).send({ value });
const del = (key: string, as: Registered, sudo: string) => api.delete(`/api/v1/admin/settings/${key}`).set(authHeader(as.accessToken)).set("X-Admin-Sudo", sudo);
const find = (body: { settings: { key: string }[] }, key: string) => body.settings.find((s) => s.key === key) as Record<string, unknown>;
const entries = () => prisma.auditLogEntry.findMany({ where: { action: "setting.change" }, orderBy: { id: "asc" } });
const register = (username: string) => api.post("/api/v1/auth/register").send({ username, password: PASSWORD });

describe("who can reach it", () => {
  it("is not there for anyone who is not an admin", async () => {
    const bob = await registerUser("bob", { password: PASSWORD });
    expect((await list(bob)).status).toBe(404);
    expect((await put("SERVER_NAME", "x", bob, "x")).status).toBe(404);
    expect((await del("SERVER_NAME", bob, "x")).status).toBe(404);
    expect((await api.get("/api/v1/admin/settings")).status).toBe(404);
  });

  it("needs two-factor sign-in to see them, and sudo mode to change one", async () => {
    const plain = await registerUser("plain", { password: PASSWORD });
    await setAdmin("plain", true);
    expect((await list(plain)).body.error).toBe("admin_requires_two_factor");
    const alice = await makeAdmin("alice");
    expect((await list(alice)).status).toBe(200);
    const noSudo = await api.put("/api/v1/admin/settings/SERVER_NAME").set(authHeader(alice.accessToken)).send({ value: "Nope" });
    expect(noSudo.body.error).toBe("sudo_required");
    expect((await api.delete("/api/v1/admin/settings/SERVER_NAME").set(authHeader(alice.accessToken))).body.error).toBe("sudo_required");
    expect(config.serverName).toBe("My Chat Server");
    expect(await prisma.serverSetting.count()).toBe(0);
  });
});

describe("what is listed", () => {
  it("lists every setting with where its value comes from, and says which the environment has locked", async () => {
    settingsEnvironment.FEDERATION_ENABLED = "true";
    settingsEnvironment.SERVER_NAME = "   "; // blank: a compose file's `${SERVER_NAME:-}` means "not set"
    const alice = await makeAdmin("alice");
    await prisma.serverSetting.create({ data: { key: "LINK_PREVIEWS_ENABLED", value: "true" } });
    const res = await list(alice);
    expect(res.status).toBe(200);
    expect(res.body.settings.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining([...SETTING_KEYS]));
    expect(res.body.settings).toHaveLength(SETTING_KEYS.length);
    expect(find(res.body, "FEDERATION_ENABLED")).toMatchObject({ source: "environment", locked: true, value: "true" });
    expect(find(res.body, "SERVER_NAME")).toMatchObject({ source: "default", locked: false, value: "My Chat Server" });
    expect(find(res.body, "LINK_PREVIEWS_ENABLED")).toMatchObject({ source: "database", locked: false, value: "true", default: "false" });
    expect(find(res.body, "FEDERATION_CONTACT_POLICY_LIMIT")).toMatchObject({ source: "default", value: "ANYONE", choices: ["ANYONE", "SHARED_COMMUNITY", "LOCAL_ONLY"] });
    expect(res.body.warnings).toEqual([]);
  });

  it("shows nothing but settings: no secret, no database address, no domain", async () => {
    const alice = await makeAdmin("alice");
    const text = JSON.stringify((await list(alice)).body);
    for (const secret of [config.jwtAccessSecret, config.jwtRefreshSecret, config.databaseUrl]) expect(text).not.toContain(secret);
  });
});

describe("the environment wins", () => {
  it("refuses to change a setting the environment sets, and leaves the table alone", async () => {
    settingsEnvironment.REGISTRATION_INVITE_ONLY = "false";
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    const res = await put("REGISTRATION_INVITE_ONLY", "true", alice, sudo);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("locked_by_environment");
    expect((await del("REGISTRATION_INVITE_ONLY", alice, sudo)).status).toBe(409);
    expect(config.registrationInviteOnly).toBe(false);
    expect(await prisma.serverSetting.count()).toBe(0);
    expect(await entries()).toHaveLength(0);
  });

  it("does not let a stored value override a variable that was set after it was stored", async () => {
    await prisma.serverSetting.create({ data: { key: "REGISTRATION_ENABLED", value: "false" } });
    settingsEnvironment.REGISTRATION_ENABLED = "true";
    config.registrationEnabled = true;
    await loadServerSettings();
    expect(config.registrationEnabled).toBe(true);
    const alice = await makeAdmin("alice");
    expect(find((await list(alice)).body, "REGISTRATION_ENABLED")).toMatchObject({ source: "environment", value: "true" });
  });

  it("refuses an unknown setting, and the ones that must never be changed from a browser", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    for (const key of ["JWT_ACCESS_SECRET", "DATABASE_URL", "SERVER_DOMAIN", "ADMIN_ENABLED", "RATE_LIMIT_MAX", "NOPE"]) {
      const res = await put(key, "x", alice, sudo);
      expect(res.status, key).toBe(404);
      expect(res.body.error, key).toBe("unknown_setting");
    }
    expect(config.adminEnabled).toBe(true);
    expect(await prisma.serverSetting.count()).toBe(0);
  });
});

describe("what is stored is held to the strict parsers", () => {
  it("refuses a typo for a switch with the words the environment variable would get, and changes nothing", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    for (const key of ["FEDERATION_ENABLED", "REGISTRATION_ENABLED", "REGISTRATION_INVITE_ONLY", "DIRECTORY_ENABLED", "LINK_PREVIEWS_ENABLED"]) {
      const res = await put(key, "fasle", alice, sudo);
      expect(res.status, key).toBe(400);
      expect(res.body.error, key).toBe("invalid_value");
      expect(res.body.message, key).toContain(key);
    }
    expect(config.federationEnabled).toBe(true);
    expect(await prisma.serverSetting.count()).toBe(0);
  });

  it("refuses a blank value, a name that is not a choice, a wildcard, an invisible character in the name", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    expect((await put("FEDERATION_ENABLED", "  ", alice, sudo)).status).toBe(400);
    expect((await put("FEDERATION_USER_DISCOVERABILITY", "everyone", alice, sudo)).status).toBe(400);
    expect((await put("FEDERATION_ALLOWED_DOMAINS", "*.example.com", alice, sudo)).status).toBe(400);
    expect((await put("SERVER_NAME", "evil‮name", alice, sudo)).status).toBe(400);
    expect((await api.put("/api/v1/admin/settings/SERVER_NAME").set(authHeader(alice.accessToken)).set("X-Admin-Sudo", sudo).send({})).status).toBe(400);
    expect(await prisma.serverSetting.count()).toBe(0);
  });

  it("stores the canonical spelling", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    expect((await put("FEDERATION_CONTACT_POLICY_LIMIT", "local_only", alice, sudo)).body.setting).toMatchObject({ value: "LOCAL_ONLY", source: "database" });
    expect((await put("FEDERATION_ENABLED", "NO", alice, sudo)).body.setting.value).toBe("false");
    expect((await prisma.serverSetting.findUniqueOrThrow({ where: { key: "FEDERATION_ENABLED" } })).value).toBe("false");
    expect((await put("FEDERATION_ALLOWED_DOMAINS", "B.example.com\nA.example.com,b.example.com", alice, sudo)).body.setting.value).toBe("b.example.com,a.example.com");
  });
});

describe("a change takes effect at once, and putting it back restores the default", () => {
  it("registration: switching it off stops sign-ups now, and resetting lets them in again", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    expect((await put("REGISTRATION_ENABLED", "false", alice, sudo)).body.setting).toMatchObject({ value: "false", source: "database" });
    const refused = await register("carol");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("registration_disabled");
    expect((await del("REGISTRATION_ENABLED", alice, sudo)).body.setting).toMatchObject({ value: "true", source: "default", updatedAt: null });
    expect((await register("carol")).status).toBe(201);
    expect(await prisma.serverSetting.count()).toBe(0);
  });

  it("invite-only: a registration then asks for a code", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    await put("REGISTRATION_INVITE_ONLY", "true", alice, sudo);
    expect((await register("carol")).body.error).toBe("registration_invite_required");
  });

  it("federation: switching it off makes the server private for other servers, at once", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    expect((await api.get("/federation/v1/users/nobody")).body.error).not.toBe("federation_disabled");
    await put("FEDERATION_ENABLED", "false", alice, sudo);
    const res = await api.get("/federation/v1/users/nobody");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("federation_disabled");
    await del("FEDERATION_ENABLED", alice, sudo);
    expect((await api.get("/federation/v1/users/nobody")).body.error).not.toBe("federation_disabled");
  });

  it("the list of servers is what the policy reads", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    await put("FEDERATION_BLOCKED_DOMAINS", "bad.example.com", alice, sudo);
    expect(config.federationPolicy.isPermitted("bad.example.com")).toBe(false);
    expect(config.federationPolicy.isPermitted("good.example.com")).toBe(true);
    await put("FEDERATION_ALLOWED_DOMAINS", "good.example.com", alice, sudo);
    expect(config.federationPolicy.isPermitted("good.example.com")).toBe(true);
    expect(config.federationPolicy.isPermitted("other.example.com")).toBe(false);
    await del("FEDERATION_BLOCKED_DOMAINS", alice, sudo);
    await del("FEDERATION_ALLOWED_DOMAINS", alice, sudo);
    expect(config.federationPolicy.isPermitted("bad.example.com")).toBe(true);
  });

  it("the discovery document says the new server name and registration mode", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    await put("SERVER_NAME", "  Our Place ", alice, sudo);
    await put("REGISTRATION_INVITE_ONLY", "true", alice, sudo);
    const doc = (await api.get("/.well-known/communication-platform")).body;
    expect(doc.serverName).toBe("Our Place");
    expect(doc.registration).toMatchObject({ enabled: true, inviteOnly: true });
  });
});

describe("settings that depend on each other", () => {
  it("refuses a server that would be both allowed and blocked, and the one it clashes with is unchanged", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    await put("FEDERATION_ALLOWED_DOMAINS", "a.example.com", alice, sudo);
    const res = await put("FEDERATION_BLOCKED_DOMAINS", "a.example.com", alice, sudo);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflicts_with_another_setting");
    expect(res.body.message).toContain("a.example.com");
    expect(await prisma.serverSetting.findUnique({ where: { key: "FEDERATION_BLOCKED_DOMAINS" } })).toBeNull();
  });

  it("makes the community default follow the limit until a default is chosen, and refuses a default wider than the limit", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    expect(config.communityVisibilityDefault).toBe("UNLISTED");
    await put("COMMUNITY_VISIBILITY_LIMIT", "INVITE_ONLY", alice, sudo);
    expect(config.communityVisibilityDefault).toBe("INVITE_ONLY");
    const wider = await put("COMMUNITY_VISIBILITY_DEFAULT", "PUBLIC", alice, sudo);
    expect(wider.status).toBe(409);
    expect(wider.body.message).toMatch(/wider than/);
    await del("COMMUNITY_VISIBILITY_LIMIT", alice, sudo);
    expect(config.communityVisibilityDefault).toBe("UNLISTED");
    await put("COMMUNITY_VISIBILITY_DEFAULT", "PUBLIC", alice, sudo);
    // The limit may not go below a default that was chosen, and the refusal leaves the limit as it was.
    const lower = await put("COMMUNITY_VISIBILITY_LIMIT", "LOCAL_ONLY", alice, sudo);
    expect(lower.status).toBe(409);
    expect(config.communityVisibilityLimit).toBe("PUBLIC");
    // Taking the chosen default away is fine: it follows the limit again.
    await del("COMMUNITY_VISIBILITY_DEFAULT", alice, sudo);
    expect(config.communityVisibilityDefault).toBe("UNLISTED");
  });

  it("checks against an environment value too: a limit below a default the environment fixed is refused", async () => {
    settingsEnvironment.COMMUNITY_VISIBILITY_DEFAULT = "PUBLIC";
    config.communityVisibilityDefault = "PUBLIC";
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    const res = await put("COMMUNITY_VISIBILITY_LIMIT", "INVITE_ONLY", alice, sudo);
    expect(res.status).toBe(409);
    expect(config.communityVisibilityLimit).toBe("PUBLIC");
  });
});

describe("another replica, and bad rows", () => {
  it("picks up a row that another replica stored, and forgets one that it removed", async () => {
    await prisma.serverSetting.create({ data: { key: "REGISTRATION_ENABLED", value: "false" } });
    expect(config.registrationEnabled).toBe(true);
    await loadServerSettings();
    expect(config.registrationEnabled).toBe(false);
    await prisma.serverSetting.deleteMany();
    await loadServerSettings();
    expect(config.registrationEnabled).toBe(true);
  });

  it("does this on a timer, so a replica notices without being asked", async () => {
    await prisma.serverSetting.create({ data: { key: "LINK_PREVIEWS_ENABLED", value: "true" } });
    const stop = startServerSettingsSync(20);
    try {
      await expect.poll(() => config.linkPreviewsEnabled, { timeout: 3000 }).toBe(true);
    } finally {
      stop();
    }
  });

  it("ignores a stored value that no longer parses, says so, and does not stop the server", async () => {
    await prisma.serverSetting.create({ data: { key: "FEDERATION_ENABLED", value: "maybe" } });
    await prisma.serverSetting.create({ data: { key: "LINK_PREVIEWS_ENABLED", value: "true" } });
    await loadServerSettings();
    expect(config.federationEnabled).toBe(true);
    expect(config.linkPreviewsEnabled).toBe(true);
    const alice = await makeAdmin("alice");
    expect(find((await list(alice)).body, "FEDERATION_ENABLED")).toMatchObject({ source: "default", value: "true" });
    expect(((find((await list(alice)).body, "FEDERATION_ENABLED").problem) as string)).toContain("FEDERATION_ENABLED");
  });

  it("applies none of the stored values when together they cannot hold, and says so", async () => {
    await prisma.serverSetting.create({ data: { key: "FEDERATION_ALLOWED_DOMAINS", value: "a.example.com" } });
    await prisma.serverSetting.create({ data: { key: "FEDERATION_BLOCKED_DOMAINS", value: "a.example.com" } });
    await prisma.serverSetting.create({ data: { key: "LINK_PREVIEWS_ENABLED", value: "true" } });
    await loadServerSettings();
    expect(config.linkPreviewsEnabled).toBe(false);
    expect(config.federationPolicy.allowed).toEqual([]);
    const alice = await makeAdmin("alice");
    expect((await list(alice)).body.warnings[0]).toContain("a.example.com");
  });
});

describe("the audit log", () => {
  it("records a change with what it was and what it became, by the admin, from the admin page", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    await put("FEDERATION_CONTACT_POLICY_LIMIT", "LOCAL_ONLY", alice, sudo);
    const [entry] = await entries();
    expect(entry).toMatchObject({ source: "admin", action: "setting.change", targetType: "setting", targetId: "FEDERATION_CONTACT_POLICY_LIMIT" });
    expect(entry.actorLabel).toContain("alice");
    expect(entry.details).toEqual({ from: "ANYONE", to: "LOCAL_ONLY" });
  });

  it("does not write a repeat that changes nothing, and does write a reset", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    await put("LINK_PREVIEWS_ENABLED", "true", alice, sudo);
    await put("LINK_PREVIEWS_ENABLED", "true", alice, sudo);
    expect(await entries()).toHaveLength(1);
    await del("LINK_PREVIEWS_ENABLED", alice, sudo);
    await del("LINK_PREVIEWS_ENABLED", alice, sudo); // nothing stored: nothing to undo
    const all = await entries();
    expect(all).toHaveLength(2);
    expect(all[1].details).toEqual({ from: "true", to: "false" });
  });

  it("records a list of servers by how many, not by name, and nothing is written for a refusal", async () => {
    const alice = await makeAdmin("alice");
    const sudo = await sudoOf(alice);
    await put("FEDERATION_ALLOWED_DOMAINS", "a.example.com,b.example.com", alice, sudo);
    expect((await put("FEDERATION_ENABLED", "fasle", alice, sudo)).status).toBe(400);
    const all = await entries();
    expect(all).toHaveLength(1);
    expect(all[0].details).toEqual({ from: "0 servers", to: "2 servers" });
    expect(JSON.stringify(all[0])).not.toContain("a.example.com");
  });
});
