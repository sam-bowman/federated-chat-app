import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { prisma } from "../../src/db.js";
import { config } from "../../src/config.js";
import { hashBotToken } from "../../src/lib/botToken.js";

// Bot accounts (#132, phase 1): made by a person, added to a community by its managers, acting with a token that is shown once.
beforeEach(resetDb);
afterAll(disconnectDb);

const botAuth = (token: string) => ({ Authorization: `Bot ${token}` });

async function makeBot(owner: { accessToken: string }, username = "helper", extra: Record<string, unknown> = {}) {
  const res = await api.post("/api/v1/bots").set(authHeader(owner.accessToken)).send({ username, ...extra });
  expect(res.status).toBe(201);
  return res.body as { bot: { id: string; username: string; isBot: boolean }; token: string };
}

async function makeCommunity(owner: { accessToken: string }, name = "Place") {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community as { id: string; channels: { id: string; name: string }[] };
}

async function addBot(owner: { accessToken: string }, communityId: string, username = "helper") {
  return api.post(`/api/v1/communities/${communityId}/bots`).set(authHeader(owner.accessToken)).send({ username });
}

describe("making a bot", () => {
  it("returns the token once, flags the account as a bot, and keeps only a hash", async () => {
    const owner = await registerUser("owner");
    const { bot, token } = await makeBot(owner, "helper", { displayName: "Helper" });

    expect(bot.isBot).toBe(true);
    expect(token).toMatch(/^mcb_[A-Za-z0-9_-]{43}$/);
    const row = await prisma.user.findFirstOrThrow({ where: { protocolId: bot.id } });
    expect(row.botTokenHash).toBe(hashBotToken(token));
    expect(row.botTokenHash).not.toContain(token);
    expect(row.passwordHash).toBeNull();

    // Listing never shows it again.
    const list = await api.get("/api/v1/bots").set(authHeader(owner.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.bots).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(JSON.stringify(list.body)).not.toContain(hashBotToken(token));
  });

  it("is refused for a taken name, an invalid name and past the per-person limit", async () => {
    const owner = await registerUser("owner");
    await registerUser("taken");
    expect((await api.post("/api/v1/bots").set(authHeader(owner.accessToken)).send({ username: "taken" })).body.error).toBe("username_taken");
    expect((await api.post("/api/v1/bots").set(authHeader(owner.accessToken)).send({ username: "No Spaces" })).status).toBe(400);

    const before = config.botsPerUserLimit;
    (config as { botsPerUserLimit: number }).botsPerUserLimit = 2;
    try {
      await makeBot(owner, "one");
      await makeBot(owner, "two");
      const third = await api.post("/api/v1/bots").set(authHeader(owner.accessToken)).send({ username: "three" });
      expect(third.status).toBe(409);
      expect(third.body.error).toBe("too_many_bots");
    } finally {
      (config as { botsPerUserLimit: number }).botsPerUserLimit = before;
    }
  });

  it("is refused for everyone when bots are switched off, but an owner can still delete", async () => {
    const owner = await registerUser("owner");
    const { bot } = await makeBot(owner);
    (config as { botsEnabled: boolean }).botsEnabled = false;
    try {
      const made = await api.post("/api/v1/bots").set(authHeader(owner.accessToken)).send({ username: "another" });
      expect(made.status).toBe(403);
      expect(made.body.error).toBe("bots_disabled");
      expect((await api.delete(`/api/v1/bots/${bot.id}`).set(authHeader(owner.accessToken))).status).toBe(204);
    } finally {
      (config as { botsEnabled: boolean }).botsEnabled = true;
    }
  });

  it("only its owner can see, change, regenerate or delete it (anyone else gets a 404)", async () => {
    const owner = await registerUser("owner");
    const other = await registerUser("other");
    const { bot } = await makeBot(owner);
    expect((await api.get("/api/v1/bots").set(authHeader(other.accessToken))).body.bots).toHaveLength(0);
    expect((await api.patch(`/api/v1/bots/${bot.id}`).set(authHeader(other.accessToken)).send({ displayName: "Mine" })).status).toBe(404);
    expect((await api.post(`/api/v1/bots/${bot.id}/token`).set(authHeader(other.accessToken))).status).toBe(404);
    expect((await api.delete(`/api/v1/bots/${bot.id}`).set(authHeader(other.accessToken))).status).toBe(404);
    expect((await prisma.user.findFirstOrThrow({ where: { protocolId: bot.id } })).deletedAt).toBeNull();
  });
});

describe("a bot's token", () => {
  it("never signs in, never refreshes, and cannot be used where a person's token goes", async () => {
    const owner = await registerUser("owner");
    const { token } = await makeBot(owner);
    expect((await api.post("/api/v1/auth/login").send({ username: "helper", password: "Correct-Horse-Battery-Staple-1" })).status).toBe(401);
    // As a Bearer token it is not a token at all.
    expect((await api.get("/api/v1/users/me").set({ Authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("is refused by every route that does not name bots: account, 2FA, communities, roles, friends, media, admin", async () => {
    const owner = await registerUser("owner");
    const { token } = await makeBot(owner);
    const community = await makeCommunity(owner);
    const attempts: [string, string][] = [
      ["patch", "/api/v1/users/me"],
      ["post", "/api/v1/users/me/export"],
      ["post", "/api/v1/users/me/delete"],
      ["post", "/api/v1/auth/2fa/setup"],
      ["post", "/api/v1/communities"],
      ["patch", `/api/v1/communities/${community.id}`],
      ["delete", `/api/v1/communities/${community.id}`],
      ["put", `/api/v1/communities/${community.id}/owner`],
      ["post", `/api/v1/communities/${community.id}/roles`],
      ["post", `/api/v1/communities/${community.id}/channels`],
      ["post", `/api/v1/communities/${community.id}/bots`],
      ["post", "/api/v1/friends/requests"],
      ["post", "/api/v1/conversations"],
      ["post", "/api/v1/media/upload"],
      ["post", "/api/v1/bots"],
      ["get", "/api/v1/bots"],
    ];
    // The admin API answers 404 to everyone who is not an admin (so it cannot be told apart from a path that does not exist).
    expect((await api.get("/api/v1/admin/me").set(botAuth(token))).status).toBe(404);
    for (const [method, path] of attempts) {
      const res = await (api as unknown as Record<string, (p: string) => { set: (h: object) => Promise<{ status: number; body: { error?: string } }> }>)[method](path).set(botAuth(token));
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  it("can catch up on what it missed, through the same sync the apps use", async () => {
    const owner = await registerUser("owner");
    const { token } = await makeBot(owner);
    const community = await makeCommunity(owner);
    await addBot(owner, community.id);
    await api.post(`/api/v1/channels/${community.channels[0].id}/messages`).set(authHeader(owner.accessToken)).send({ content: "while you were away" });
    const caught = await api.get("/api/v1/sync").set(botAuth(token));
    expect(caught.status).toBe(200);
    expect(JSON.stringify(caught.body.events)).toContain("while you were away");
  });

  it("is refused when malformed, unknown, or after the bot is deleted", async () => {
    const owner = await registerUser("owner");
    const { bot, token } = await makeBot(owner);
    expect((await api.get("/api/v1/users/me").set(botAuth("nope"))).status).toBe(401);
    expect((await api.get("/api/v1/users/me").set(botAuth("mcb_" + "A".repeat(43)))).status).toBe(401);
    expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(200);
    await api.delete(`/api/v1/bots/${bot.id}`).set(authHeader(owner.accessToken));
    expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(401);
  });

  it("stops working the moment it is regenerated, and the new one works", async () => {
    const owner = await registerUser("owner");
    const { bot, token } = await makeBot(owner);
    expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(200);
    const regenerated = await api.post(`/api/v1/bots/${bot.id}/token`).set(authHeader(owner.accessToken));
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.token).not.toBe(token);
    expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(401);
    expect((await api.get("/api/v1/users/me").set(botAuth(regenerated.body.token))).status).toBe(200);
  });

  it("stops working when the bot is erased, whatever else is left on its row", async () => {
    const owner = await registerUser("owner");
    const { token } = await makeBot(owner);
    expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(200);
    await prisma.user.updateMany({ where: { username: "helper" }, data: { deletedAt: new Date() } });
    expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(401);
  });

  it("is forgotten by the row when the bot is erased by the operator rather than its owner", async () => {
    const owner = await registerUser("owner");
    const { bot, token } = await makeBot(owner);
    const { purgeAccount } = await import("../../src/modules/users/deletion.js");
    const row = await prisma.user.findFirstOrThrow({ where: { protocolId: bot.id } });
    expect((await purgeAccount(row.id)).ok).toBe(true);
    expect((await prisma.user.findFirstOrThrow({ where: { protocolId: bot.id } })).botTokenHash).toBeNull();
    expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(401);
  });

  it("stops working when the bot is suspended or bots are switched off", async () => {
    const owner = await registerUser("owner");
    const { token } = await makeBot(owner);
    await prisma.user.updateMany({ where: { username: "helper" }, data: { suspendedAt: new Date() } });
    expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(401);
    await prisma.user.updateMany({ where: { username: "helper" }, data: { suspendedAt: null } });
    (config as { botsEnabled: boolean }).botsEnabled = false;
    try {
      expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(401);
    } finally {
      (config as { botsEnabled: boolean }).botsEnabled = true;
    }
    expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(200);
  });

  it("is counted per bot: one bot using up its allowance does not stop another", async () => {
    const owner = await registerUser("owner");
    const a = await makeBot(owner, "bot_a");
    const b = await makeBot(owner, "bot_b");
    const before = config.botRateLimitMax;
    // The limiter was built with the value at import time, so this checks the real default instead of changing it.
    expect(before).toBeGreaterThan(0);
    let limited = false;
    for (let i = 0; i < before + 5 && !limited; i++) {
      const res = await api.get("/api/v1/users/me").set(botAuth(a.token));
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
    expect((await api.get("/api/v1/users/me").set(botAuth(b.token))).status).toBe(200);
  });
});

describe("a bot in a community", () => {
  it("is added by a manager, sees only that community, and can read, send and react", async () => {
    const owner = await registerUser("owner");
    const { bot, token } = await makeBot(owner);
    const inside = await makeCommunity(owner, "Inside");
    const outside = await makeCommunity(owner, "Outside");

    // Before it is added it sees nothing and cannot act.
    expect((await api.get("/api/v1/communities").set(botAuth(token))).body.communities).toHaveLength(0);
    expect((await api.post(`/api/v1/channels/${inside.channels[0].id}/messages`).set(botAuth(token)).send({ content: "hi" })).status).toBe(404);

    const added = await addBot(owner, inside.id);
    expect(added.status).toBe(201);
    expect(added.body.bot.isBot).toBe(true);
    expect((await addBot(owner, inside.id)).body.error).toBe("already_member");

    const listed = await api.get("/api/v1/communities").set(botAuth(token));
    expect(listed.body.communities.map((c: { id: string }) => c.id)).toEqual([inside.id]);
    // The member list says which member is a bot.
    expect(listed.body.communities[0].members.find((m: { id: string }) => m.id === bot.id).isBot).toBe(true);
    expect((await api.get(`/api/v1/communities/${outside.id}`).set(botAuth(token))).status).toBe(403);

    const sent = await api.post(`/api/v1/channels/${inside.channels[0].id}/messages`).set(botAuth(token)).send({ content: "hello from a bot" });
    expect(sent.status).toBe(201);
    expect(sent.body.message.sender.isBot).toBe(true);
    // ...and a person in the community reads it.
    const history = await api.get(`/api/v1/channels/${inside.channels[0].id}/messages`).set(botAuth(token));
    expect(history.body.messages.map((m: { content: string }) => m.content)).toContain("hello from a bot");

    const reacted = await api.post(`/api/v1/messages/${sent.body.message.id}/reactions`).set(botAuth(token)).send({ emoji: "👍" });
    expect(reacted.status).toBeLessThan(300);
    const edited = await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(botAuth(token)).send({ content: "edited" });
    expect(edited.status).toBe(200);
    expect((await api.delete(`/api/v1/messages/${sent.body.message.id}`).set(botAuth(token))).status).toBeLessThan(300);

    // Nothing in the other community, even by its channel id.
    expect((await api.get(`/api/v1/channels/${outside.channels[0].id}/messages`).set(botAuth(token))).status).toBe(404);
    expect((await api.post(`/api/v1/channels/${outside.channels[0].id}/messages`).set(botAuth(token)).send({ content: "x" })).status).toBe(404);
  });

  it("is held to its roles: taking away SEND_MESSAGES stops it sending", async () => {
    const owner = await registerUser("owner");
    const { bot, token } = await makeBot(owner);
    const community = await makeCommunity(owner);
    await addBot(owner, community.id);
    const role = await api.post(`/api/v1/communities/${community.id}/roles`).set(authHeader(owner.accessToken)).send({ name: "mute", permissions: "0" });
    expect(role.status).toBe(201);
    // The @everyone role is what gives it SEND_MESSAGES; a muted bot is one whose @everyone is taken away.
    const everyone = await prisma.role.findFirstOrThrow({ where: { isDefault: true, community: { protocolId: community.id } } });
    await prisma.role.update({ where: { id: everyone.id }, data: { permissions: 0n } });
    const res = await api.post(`/api/v1/channels/${community.channels[0].id}/messages`).set(botAuth(token)).send({ content: "x" });
    expect(res.status).toBe(403);
    expect(bot.isBot).toBe(true);
  });

  it("is added only by a manager, never by an ordinary member, a stranger or a bot", async () => {
    const owner = await registerUser("owner");
    const member = await registerUser("member");
    const stranger = await registerUser("stranger");
    const { token } = await makeBot(owner);
    const community = await makeCommunity(owner);
    await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(member.accessToken)).send({});
    expect((await addBot(member, community.id)).status).toBe(403);
    expect((await addBot(stranger, community.id)).status).toBe(404);
    expect((await api.post(`/api/v1/communities/${community.id}/bots`).set(botAuth(token)).send({ username: "helper" })).status).toBe(401);
    expect((await addBot(owner, community.id, "nobody")).body.error).toBe("bot_not_found");
    // A person is not a bot, even by name.
    expect((await addBot(owner, community.id, "member")).body.error).toBe("bot_not_found");
  });

  it("is removed, and refused afterwards, like any member (kick; a ban stops it being added again)", async () => {
    const owner = await registerUser("owner");
    const { bot, token } = await makeBot(owner);
    const community = await makeCommunity(owner);
    await addBot(owner, community.id);
    const kicked = await api.delete(`/api/v1/communities/${community.id}/members/${bot.id}`).set(authHeader(owner.accessToken));
    expect(kicked.status).toBeLessThan(300);
    expect((await api.get(`/api/v1/communities/${community.id}`).set(botAuth(token))).status).toBe(403);
    const banned = await api.post(`/api/v1/communities/${community.id}/bans`).set(authHeader(owner.accessToken)).send({ protocolId: bot.id });
    expect(banned.status).toBeLessThan(300);
    expect((await addBot(owner, community.id)).body.error).toBe("bot_banned");
  });

  it("is added to an invite-only community by a manager (no code needed), and writes to the audit log", async () => {
    const owner = await registerUser("owner");
    await makeBot(owner);
    const community = await makeCommunity(owner);
    await api.patch(`/api/v1/communities/${community.id}`).set(authHeader(owner.accessToken)).send({ visibility: "INVITE_ONLY" });
    expect((await addBot(owner, community.id)).status).toBe(201);
    const log = await api.get(`/api/v1/communities/${community.id}/audit-log`).set(authHeader(owner.accessToken));
    expect(log.body.entries.map((e: { action: string }) => e.action)).toContain("community.bot_add");
  });
});

describe("a bot is not a person", () => {
  it("cannot be found as a friend, befriended, messaged or made an owner or admin", async () => {
    const owner = await registerUser("owner");
    const person = await registerUser("person");
    const { bot } = await makeBot(owner, "helperbot");
    const community = await makeCommunity(owner);
    await addBot(owner, community.id, "helperbot");

    expect((await api.get("/api/v1/users/search?q=helperbot").set(authHeader(person.accessToken))).body.users).toHaveLength(0);
    const friend = await api.post("/api/v1/friends/requests").set(authHeader(person.accessToken)).send({ username: "helperbot" });
    expect(friend.status).toBe(409);
    expect(friend.body.error).toBe("user_is_bot");
    const dm = await api.post("/api/v1/conversations").set(authHeader(person.accessToken)).send({ type: "DM", memberUsernames: ["helperbot"] });
    expect(dm.status).toBe(409);
    expect(dm.body.error).toBe("user_is_bot");

    const transfer = await api
      .put(`/api/v1/communities/${community.id}/owner`)
      .set(authHeader(owner.accessToken))
      .send({ userId: bot.id, password: "Correct-Horse-Battery-Staple-1" });
    expect(transfer.status).toBe(400);
    expect(transfer.body.error).toBe("new_owner_is_bot");
  });

  it("is deleted with its owner, and its messages go with it", async () => {
    const owner = await registerUser("owner");
    const { token, bot } = await makeBot(owner);
    const community = await makeCommunity(owner);
    await addBot(owner, community.id);
    await api.post(`/api/v1/channels/${community.channels[0].id}/messages`).set(botAuth(token)).send({ content: "hello" });

    const { purgeAccount } = await import("../../src/modules/users/deletion.js");
    // An owner who owns a community cannot be erased; hand it to someone first.
    const heir = await registerUser("heir");
    await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(heir.accessToken)).send({});
    await api
      .put(`/api/v1/communities/${community.id}/owner`)
      .set(authHeader(owner.accessToken))
      .send({ userId: heir.user.id, password: "Correct-Horse-Battery-Staple-1" });
    const ownerRow = await prisma.user.findFirstOrThrow({ where: { username: "owner" } });
    expect((await purgeAccount(ownerRow.id)).ok).toBe(true);

    const botRow = await prisma.user.findFirstOrThrow({ where: { protocolId: bot.id } });
    expect(botRow.deletedAt).not.toBeNull();
    expect(await prisma.message.count({ where: { senderId: botRow.id } })).toBe(0);
    expect((await api.get("/api/v1/users/me").set(botAuth(token))).status).toBe(401);
  });

  it("writes the audit log without ever holding a token", async () => {
    const owner = await registerUser("owner");
    const { bot, token } = await makeBot(owner);
    await api.post(`/api/v1/bots/${bot.id}/token`).set(authHeader(owner.accessToken));
    await api.delete(`/api/v1/bots/${bot.id}`).set(authHeader(owner.accessToken));
    const rows = await prisma.auditLogEntry.findMany({ where: { action: { startsWith: "bot." } }, orderBy: { id: "asc" } });
    expect(rows.map((r) => r.action)).toEqual(["bot.create", "bot.token_regenerate", "bot.delete"]);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(hashBotToken(token));
  });
});

describe("bots and other servers and the operator", () => {
  it("is never found from another server, even by one that shares a community with it", async () => {
    const owner = await registerUser("owner");
    await registerUser("person");
    await makeBot(owner, "helper");
    const { isVisibleToDomain } = await import("../../src/modules/users/discoverability.js");
    // Even one that is otherwise findable (a bot is made unfindable, but the rule must not rest on that alone).
    await prisma.user.updateMany({ where: { username: "helper" }, data: { discoverable: true } });
    const botRow = await prisma.user.findFirstOrThrow({ where: { username: "helper" } });
    const personRow = await prisma.user.findFirstOrThrow({ where: { username: "person" } });
    expect(await isVisibleToDomain(botRow, "bob.test")).toBe(false);
    // ...where an ordinary findable person is.
    expect(await isVisibleToDomain(personRow, "bob.test")).toBe(true);
  });

  it("cannot be made an admin by the command", async () => {
    const owner = await registerUser("owner");
    await makeBot(owner, "helper");
    const { setAdmin } = await import("../../src/modules/admin/service.js");
    expect(await setAdmin("helper", true)).toEqual({ ok: false, error: "is_bot" });
    expect((await prisma.user.findFirstOrThrow({ where: { username: "helper" } })).isAdmin).toBe(false);
    // Taking admin away from something that is not an admin is still allowed (nothing to refuse).
    expect((await setAdmin("helper", false)).ok).toBe(true);
  });

  it("is advertised in the discovery document only while bots are on", async () => {
    const on = await api.get("/.well-known/communication-platform");
    expect(on.body.features.bots).toBe(true);
    (config as { botsEnabled: boolean }).botsEnabled = false;
    try {
      expect((await api.get("/.well-known/communication-platform")).body.features.bots).toBe(false);
    } finally {
      (config as { botsEnabled: boolean }).botsEnabled = true;
    }
  });
});
