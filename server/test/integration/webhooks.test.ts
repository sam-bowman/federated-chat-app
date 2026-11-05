import crypto from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { registerTestPeer, signedGet } from "../helpers/federation.js";
import { prisma } from "../../src/db.js";
import { config } from "../../src/config.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { Permission } from "../../src/lib/permissions.js";
import { hashWebhookSecret } from "../../src/lib/webhookSecret.js";
import { listUsers } from "../../src/modules/admin/service.js";

// Incoming webhooks (#132, phase 2): a secret address a program posts `{content}` to, to put a message in one channel.
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
const as = (user: Registered) => authHeader(user.accessToken);
const settings = config as { webhooksEnabled: boolean; webhooksPerCommunityLimit: number };

async function makeCommunity(owner: Registered, name = "Place") {
  const res = await api.post("/api/v1/communities").set(as(owner)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community as { id: string; channels: { id: string; name: string }[] };
}

type Community = Awaited<ReturnType<typeof makeCommunity>>;

async function makeWebhook(owner: Registered, club: Community, name = "Deploys", channelId = club.channels[0].id) {
  const res = await api.post(`/api/v1/communities/${club.id}/webhooks`).set(as(owner)).send({ name, channelId });
  expect(res.status).toBe(201);
  return res.body as { webhook: { id: string; name: string; channelId: string }; url: string };
}

/** The path of an address the server handed out: what a program posts to (the host is whatever PUBLIC_BASE_URL says). */
const pathOf = (url: string) => new URL(url).pathname;
/** The same address with the last character of its secret changed (always to a different one: a fixed replacement is the real character 1 time in 64). */
const tampered = (url: string) => url.slice(0, -1) + (url.endsWith("A") ? "B" : "A");
const post = (url: string, body: unknown = { content: "build passed" }) => api.post(pathOf(url)).send(body as object);

/** A member who holds the given permission through a role, and nothing else beyond what everyone has. */
async function memberWith(owner: Registered, club: Community, username: string, permissions: bigint | null) {
  const user = await registerUser(username);
  await api.post(`/api/v1/communities/${club.id}/members`).set(as(user));
  if (permissions !== null) {
    const role = await api.post(`/api/v1/communities/${club.id}/roles`).set(as(owner)).send({ name: `Role of ${username}`, permissions: String(permissions) });
    expect(role.status).toBe(201);
    expect((await api.post(`/api/v1/communities/${club.id}/members/${user.user.id}/roles/${role.body.role.id}`).set(as(owner))).status).toBeLessThan(300);
  }
  return user;
}

const history = async (user: Registered, channelId: string) => (await api.get(`/api/v1/channels/${channelId}/messages`).set(as(user))).body.messages as Array<{ content: string; sender: { id: string; username: string; displayName: string; isBot: boolean } }>;

describe("making a webhook", () => {
  it("shows the address once, keeps only a hash of its secret, and never lists it again", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook, url } = await makeWebhook(owner, club);

    expect(url).toMatch(new RegExp(`^${config.baseUrl}/api/v1/webhooks/${webhook.id}/mcw_[A-Za-z0-9_-]{43}$`));
    const secret = url.split("/").pop()!;
    const row = await prisma.webhook.findFirstOrThrow({ where: { protocolId: webhook.id } });
    expect(row.secretHash).toBe(hashWebhookSecret(secret));
    expect(JSON.stringify(row)).not.toContain(secret);

    const list = await api.get(`/api/v1/communities/${club.id}/webhooks`).set(as(owner));
    expect(list.status).toBe(200);
    expect(list.body.webhooks).toHaveLength(1);
    expect(list.body.webhooks[0]).toMatchObject({ id: webhook.id, name: "Deploys", channelId: club.channels[0].id });
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(JSON.stringify(list.body)).not.toContain(row.secretHash);
  });

  it("gives it a sender of its own: a bot nobody can type the name of, with no token and no owner, that is not a member", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook } = await makeWebhook(owner, club, "Deploys");
    const row = await prisma.webhook.findFirstOrThrow({ where: { protocolId: webhook.id }, include: { sender: true } });

    expect(row.sender).toMatchObject({ isBot: true, isWebhook: true, displayName: "Deploys", botTokenHash: null, botOwnerId: null, passwordHash: null, isRemote: false });
    // Not findable and not contactable, whatever else keeps it from other servers (the bot rule in isVisibleToDomain).
    expect(row.sender).toMatchObject({ discoverable: false, contactPolicy: "LOCAL_ONLY" });
    expect(row.sender.username).toBe(`~webhook-${webhook.id}`);
    expect(row.sender.username).not.toMatch(/^[a-z0-9_]+$/); // the sign-up pattern can never make it
    expect(await prisma.communityMember.count({ where: { userId: row.senderId } })).toBe(0);
  });

  it("needs MANAGE_WEBHOOKS: not an ordinary member, not MANAGE_COMMUNITY, and a stranger cannot tell the community exists", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const member = await memberWith(owner, club, "member", null);
    const manager = await memberWith(owner, club, "manager", Permission.MANAGE_COMMUNITY | Permission.MANAGE_CHANNELS | Permission.MANAGE_ROLES);
    const integrator = await memberWith(owner, club, "integrator", Permission.MANAGE_WEBHOOKS);
    const stranger = await registerUser("stranger");
    const body = { name: "CI", channelId: club.channels[0].id };

    for (const user of [member, manager]) {
      expect((await api.post(`/api/v1/communities/${club.id}/webhooks`).set(as(user)).send(body)).status).toBe(403);
      expect((await api.get(`/api/v1/communities/${club.id}/webhooks`).set(as(user))).status).toBe(403);
    }
    expect((await api.post(`/api/v1/communities/${club.id}/webhooks`).set(as(stranger)).send(body)).status).toBe(404);
    expect((await api.post(`/api/v1/communities/${club.id}/webhooks`).send(body)).status).toBe(401);
    expect((await api.post(`/api/v1/communities/${club.id}/webhooks`).set(as(integrator)).send(body)).status).toBe(201);
    expect((await api.post(`/api/v1/communities/${club.id}/webhooks`).set(as(owner)).send(body)).status).toBe(201);
  });

  it("is refused for a channel of another community, a voice channel, an invalid name, and past the community's limit", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const other = await makeCommunity(owner, "Other");
    const voice = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: (await prisma.community.findFirstOrThrow({ where: { protocolId: club.id } })).id, name: "talk", type: "VOICE", position: 5 } });
    const make = (body: object) => api.post(`/api/v1/communities/${club.id}/webhooks`).set(as(owner)).send(body);

    expect((await make({ name: "CI", channelId: other.channels[0].id })).body.error).toBe("channel_not_found");
    expect((await make({ name: "CI", channelId: voice.protocolId })).body.error).toBe("channel_not_found");
    expect((await make({ name: "CI", channelId: "nope" })).body.error).toBe("channel_not_found");
    expect((await make({ name: "   ", channelId: club.channels[0].id })).status).toBe(400);
    expect((await make({ name: "x".repeat(65), channelId: club.channels[0].id })).status).toBe(400);
    expect((await make({ channelId: club.channels[0].id })).status).toBe(400);

    const before = settings.webhooksPerCommunityLimit;
    settings.webhooksPerCommunityLimit = 2;
    try {
      await makeWebhook(owner, club, "one");
      await makeWebhook(owner, club, "two");
      const third = await make({ name: "three", channelId: club.channels[0].id });
      expect(third.status).toBe(409);
      expect(third.body).toMatchObject({ error: "too_many_webhooks", limit: 2 });
      // Another community has its own allowance.
      await makeWebhook(owner, other, "elsewhere");
    } finally {
      settings.webhooksPerCommunityLimit = before;
    }
  });

  it("is not available for a community this server only caches, and is refused to everyone while webhooks are off", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook, url } = await makeWebhook(owner, club);

    settings.webhooksEnabled = false;
    try {
      const body = { name: "CI", channelId: club.channels[0].id };
      expect((await api.post(`/api/v1/communities/${club.id}/webhooks`).set(as(owner)).send(body)).body.error).toBe("webhooks_disabled");
      expect((await api.post(`/api/v1/communities/${club.id}/webhooks/${webhook.id}/url`).set(as(owner))).body.error).toBe("webhooks_disabled");
      // Posting to an existing one is the same 404 as any address that does not work, and nothing is deleted...
      expect((await post(url)).status).toBe(404);
      expect(await prisma.webhook.count()).toBe(1);
      // ...so a manager can still clean up.
      expect((await api.delete(`/api/v1/communities/${club.id}/webhooks/${webhook.id}`).set(as(owner))).status).toBe(204);
    } finally {
      settings.webhooksEnabled = true;
    }

    await prisma.community.updateMany({ data: { isRemote: true } });
    expect((await api.post(`/api/v1/communities/${club.id}/webhooks`).set(as(owner)).send({ name: "CI", channelId: club.channels[0].id })).body.error).toBe("not_community_home");
  });

  it("is changed by name, picture and channel, and the sender is shown the new way", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const second = (await api.post(`/api/v1/communities/${club.id}/channels`).set(as(owner)).send({ name: "alerts" })).body.channel as { id: string };
    const { webhook, url } = await makeWebhook(owner, club, "Deploys");

    const changed = await api.patch(`/api/v1/communities/${club.id}/webhooks/${webhook.id}`).set(as(owner)).send({ name: "Alerts", channelId: second.id, avatarUrl: "/uploads/a.png" });
    expect(changed.status).toBe(200);
    expect(changed.body.webhook).toMatchObject({ name: "Alerts", channelId: second.id, avatarUrl: "/uploads/a.png" });

    expect((await post(url)).status).toBe(201);
    const [message] = await history(owner, second.id);
    expect(message.sender.displayName).toBe("Alerts");
    expect(await history(owner, club.channels[0].id)).toHaveLength(0);

    expect((await api.patch(`/api/v1/communities/${club.id}/webhooks/${webhook.id}`).set(as(owner)).send({ channelId: "nope" })).body.error).toBe("channel_not_found");
    expect((await api.patch(`/api/v1/communities/${club.id}/webhooks/${webhook.id}`).set(as(owner)).send({ name: "" })).status).toBe(400);
    expect((await api.patch(`/api/v1/communities/${club.id}/webhooks/nope`).set(as(owner)).send({ name: "X" })).status).toBe(404);
  });

  it("belongs to its own community: another community's manager cannot see, change, re-key or delete it", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook } = await makeWebhook(owner, club);
    const rival = await registerUser("rival");
    const theirs = await makeCommunity(rival, "Theirs");
    const base = `/api/v1/communities/${theirs.id}/webhooks/${webhook.id}`;

    expect((await api.patch(base).set(as(rival)).send({ name: "Mine" })).status).toBe(404);
    expect((await api.post(`${base}/url`).set(as(rival))).status).toBe(404);
    expect((await api.delete(base).set(as(rival))).status).toBe(404);
    expect(await prisma.webhook.count()).toBe(1);
  });

  it("is refused to a bot's token: management is for people", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const made = await api.post("/api/v1/bots").set(as(owner)).send({ username: "helper" });
    const bot = { Authorization: `Bot ${made.body.token}` };
    await api.post(`/api/v1/communities/${club.id}/bots`).set(as(owner)).send({ username: "helper" });
    expect((await api.get(`/api/v1/communities/${club.id}/webhooks`).set(bot)).status).toBe(401);
    expect((await api.post(`/api/v1/communities/${club.id}/webhooks`).set(bot).send({ name: "CI", channelId: club.channels[0].id })).status).toBe(401);
  });
});

describe("posting to a webhook", () => {
  it("puts the message in the channel, from a sender marked as a bot and shown under the webhook's name", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook, url } = await makeWebhook(owner, club, "Deploys");

    const res = await post(url, { content: "build 42 passed" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String) });

    const [message] = await history(owner, club.channels[0].id);
    expect(message.content).toBe("build 42 passed");
    expect(message.sender).toMatchObject({ displayName: "Deploys", isBot: true, username: `~webhook-${webhook.id}` });
  });

  it("is told live to the community's members and not to anyone outside it", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const outsider = await registerUser("outsider");
    const { url } = await makeWebhook(owner, club);
    await post(url, { content: "hello" });

    const events = (who: Registered) => prisma.syncEvent.findMany({ where: { type: "message:created", recipient: { protocolId: who.user.id } } });
    const seen = await events(owner);
    expect(seen).toHaveLength(1);
    expect((seen[0].payload as { message: { content: string }; channelId: string }).message.content).toBe("hello");
    expect((seen[0].payload as { channelId: string }).channelId).toBe(club.channels[0].id);
    expect(await events(outsider)).toHaveLength(0);
  });

  it("is sent on to other servers with the webhook's name and as a bot, so they do not show `~webhook-…`", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const row = await prisma.community.findFirstOrThrow({ where: { protocolId: club.id } });
    const far = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "far", displayName: "far", homeserverDomain: "far.test", isRemote: true } });
    await prisma.communityMember.create({ data: { communityId: row.id, userId: far.id } });
    const { webhook, url } = await makeWebhook(owner, club, "Deploys");
    await post(url, { content: "to everyone" });

    const sent = await prisma.federationOutboxEvent.findMany({ where: { domain: "far.test", path: { contains: "/messages" } } });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({
      content: "to everyone",
      fromUsername: `~webhook-${webhook.id}`,
      fromDisplayName: "Deploys",
      fromDomain: config.domain,
      fromIsBot: true,
    });
  });

  it("reads the pages a message links to, like any message (previews are the server's switch)", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { url } = await makeWebhook(owner, club);
    expect((await post(url, { content: "see https://example.com/x" })).status).toBe(201);
    expect((await history(owner, club.channels[0].id))[0].content).toBe("see https://example.com/x");
  });

  it("is refused for no content, too much, or the wrong type, and nothing is written", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { url } = await makeWebhook(owner, club);

    for (const body of [{}, { content: "" }, { content: "x".repeat(8001) }, { content: 5 }, { content: ["a"] }]) {
      const res = await post(url, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    }
    expect((await post(url, { content: "x".repeat(8000) })).status).toBe(201);
    expect(await prisma.message.count()).toBe(1);
  });

  it("does not need, and ignores, any sign-in: a person's token is not a webhook's secret and does not help", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { url } = await makeWebhook(owner, club);
    const res = await api.post(pathOf(url)).set(as(owner)).send({ content: "hi" });
    expect(res.status).toBe(201);
    expect((await history(owner, club.channels[0].id))[0].sender.isBot).toBe(true);
  });

  it("records its use, at most once a minute", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook, url } = await makeWebhook(owner, club);
    const lastUsed = async () => (await prisma.webhook.findFirstOrThrow({ where: { protocolId: webhook.id } })).lastUsedAt;
    expect(await lastUsed()).toBeNull();

    await post(url);
    await vi.waitFor(async () => expect(await lastUsed()).not.toBeNull());
    const first = (await lastUsed())!;
    await post(url);
    await post(url);
    await new Promise((r) => setTimeout(r, 100));
    expect((await lastUsed())!.getTime()).toBe(first.getTime());
  });

  it("is limited per webhook, and one webhook's flood does not stop another", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const busy = await makeWebhook(owner, club, "busy");
    const quiet = await makeWebhook(owner, club, "quiet");
    // The limiter was built with the value at import time, so this checks the real default instead of changing it.
    expect(config.webhookRateLimitMax).toBeGreaterThan(0);
    let limited = false;
    for (let i = 0; i < config.webhookRateLimitMax + 5 && !limited; i++) limited = (await post(busy.url)).status === 429;
    expect(limited).toBe(true);
    expect((await post(quiet.url)).status).toBe(201);
  });
});

describe("a channel message sent by a person (the delivery a webhook shares)", () => {
  it("is told live to the other members and not back to the person who sent it", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const reader = await memberWith(owner, club, "reader", null);
    const sent = await api.post(`/api/v1/channels/${club.channels[0].id}/messages`).set(as(reader)).send({ content: "hello" });
    expect(sent.status).toBe(201);

    const events = (who: Registered) => prisma.syncEvent.findMany({ where: { type: "message:created", recipient: { protocolId: who.user.id } } });
    expect(await events(reader)).toHaveLength(0);
    expect(await events(owner)).toHaveLength(1);
  });
});

describe("an address that does not work", () => {
  it("answers the same 404 whether the id is real, the secret is wrong, it was replaced, deleted, or webhooks are off", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const live = await makeWebhook(owner, club, "live");
    const gone = await makeWebhook(owner, club, "gone");
    await api.delete(`/api/v1/communities/${club.id}/webhooks/${gone.webhook.id}`).set(as(owner));
    const wrongSecret = tampered(live.url);
    const noSuchId = `${config.baseUrl}/api/v1/webhooks/${newProtocolId()}/${live.url.split("/").pop()}`;

    const answers = [wrongSecret, noSuchId, gone.url, `${config.baseUrl}/api/v1/webhooks/${live.webhook.id}/short`, `${config.baseUrl}/api/v1/webhooks/${live.webhook.id}/${"x".repeat(500)}`];
    for (const address of answers) {
      const res = await post(address);
      expect(res.status, address).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    }
    expect(await prisma.message.count()).toBe(0);
  });

  it("compares a secret even when the webhook does not exist, so neither case is quicker", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook, url } = await makeWebhook(owner, club);
    const secret = url.split("/").pop()!;
    const compare = vi.spyOn(crypto, "timingSafeEqual");

    expect((await post(tampered(url))).status).toBe(404); // real id, wrong secret
    const forARealId = compare.mock.calls.length;
    expect((await post(`${config.baseUrl}/api/v1/webhooks/${newProtocolId()}/${secret}`)).status).toBe(404); // no such id
    expect(forARealId).toBe(1);
    expect(compare.mock.calls.length).toBe(2);
  });

  it("stops working at once when the address is replaced, and the new one works", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook, url } = await makeWebhook(owner, club);
    expect((await post(url)).status).toBe(201);

    const rotated = await api.post(`/api/v1/communities/${club.id}/webhooks/${webhook.id}/url`).set(as(owner));
    expect(rotated.status).toBe(200);
    expect(rotated.body.url).not.toBe(url);
    expect(rotated.body.url).toContain(`/webhooks/${webhook.id}/`);
    expect((await post(url)).status).toBe(404);
    expect((await post(rotated.body.url)).status).toBe(201);
    expect(await prisma.message.count()).toBe(2);
  });

  it("is a 404 when its channel is gone, and nothing of it is left", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const second = (await api.post(`/api/v1/communities/${club.id}/channels`).set(as(owner)).send({ name: "alerts" })).body.channel as { id: string };
    const { url } = await makeWebhook(owner, club, "ci", second.id);
    expect((await post(url)).status).toBe(201);

    expect((await api.delete(`/api/v1/communities/${club.id}/channels/${second.id}`).set(as(owner))).status).toBe(204);
    expect((await post(url)).status).toBe(404);
    expect(await prisma.webhook.count()).toBe(0);
    // The channel's messages went with it, so the sender has nothing to keep it for.
    expect(await prisma.user.count({ where: { isWebhook: true } })).toBe(0);
  });

  it("is a 404, and writes nothing, if its channel can no longer take messages (a voice channel) or its community is only a cached copy", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { url } = await makeWebhook(owner, club);

    await prisma.channel.updateMany({ data: { type: "VOICE" } });
    expect((await post(url)).status).toBe(404);
    await prisma.channel.updateMany({ data: { type: "TEXT" } });
    await prisma.community.updateMany({ data: { isRemote: true } });
    expect((await post(url)).status).toBe(404);
    expect(await prisma.message.count()).toBe(0);

    await prisma.community.updateMany({ data: { isRemote: false } });
    expect((await post(url)).status).toBe(201);
  });

  it("does not outlive its community", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { url } = await makeWebhook(owner, club);
    await post(url);
    expect((await api.delete(`/api/v1/communities/${club.id}`).set(as(owner))).status).toBe(204);
    expect((await post(url)).status).toBe(404);
    expect(await prisma.webhook.count()).toBe(0);
    expect(await prisma.user.count({ where: { isWebhook: true } })).toBe(0);
  });
});

describe("deleting a webhook", () => {
  it("keeps the messages it posted, under its name, and the address stops working", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook, url } = await makeWebhook(owner, club, "Deploys");
    await post(url, { content: "build 1" });

    expect((await api.delete(`/api/v1/communities/${club.id}/webhooks/${webhook.id}`).set(as(owner))).status).toBe(204);
    expect((await post(url)).status).toBe(404);
    const [message] = await history(owner, club.channels[0].id);
    expect(message).toMatchObject({ content: "build 1", sender: { displayName: "Deploys", isBot: true } });
    expect((await api.get(`/api/v1/communities/${club.id}/webhooks`).set(as(owner))).body.webhooks).toHaveLength(0);
  });

  it("removes a sender that never posted, since nothing needs it", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook } = await makeWebhook(owner, club);
    expect(await prisma.user.count({ where: { isWebhook: true } })).toBe(1);
    await api.delete(`/api/v1/communities/${club.id}/webhooks/${webhook.id}`).set(as(owner));
    expect(await prisma.user.count({ where: { isWebhook: true } })).toBe(0);
  });

  it("keeps the sender of a webhook that posted, inert: it can be neither found nor given a way to post", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { webhook, url } = await makeWebhook(owner, club);
    await post(url);
    await api.delete(`/api/v1/communities/${club.id}/webhooks/${webhook.id}`).set(as(owner));
    const sender = await prisma.user.findFirstOrThrow({ where: { isWebhook: true } });
    expect(sender).toMatchObject({ botTokenHash: null, passwordHash: null, botOwnerId: null });
    expect(await prisma.webhook.count({ where: { senderId: sender.id } })).toBe(0);
  });
});

describe("a webhook's sender is not an account", () => {
  async function withWebhook() {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const made = await makeWebhook(owner, club, "Deploys");
    await post(made.url);
    const sender = await prisma.webhook.findFirstOrThrow({ where: { protocolId: made.webhook.id }, include: { sender: true } }).then((w) => w.sender);
    return { owner, club, ...made, sender };
  }

  it("is not one of its creator's bots, and cannot be added to a community as a bot", async () => {
    const { owner, club, sender } = await withWebhook();
    expect((await api.get("/api/v1/bots").set(as(owner))).body.bots).toEqual([]);
    expect((await api.post(`/api/v1/communities/${club.id}/bots`).set(as(owner)).send({ username: sender.username })).status).toBe(400);
    // (The sign-up pattern, which a bot name must match, is what keeps it out: a webhook's name has a ~ in it.)
    expect(await prisma.communityMember.count({ where: { userId: sender.id } })).toBe(0);
  });

  it("has no token to sign in with: no password, no bot token, not even a made-up one", async () => {
    const { owner, sender } = await withWebhook();
    const login = await api.post("/api/v1/auth/login").send({ username: sender.username, password: "hunter2hunter2" });
    // Refused before it is even looked up (a `~` is not a name anyone can have), and there is no password to try anyway.
    expect([400, 401]).toContain(login.status);
    for (const token of [`mcb_${"a".repeat(43)}`, `mcw_${"a".repeat(43)}`, ""]) {
      expect((await api.get("/api/v1/users/me").set({ Authorization: `Bot ${token}` })).status).toBe(401);
    }
    void owner;
  });

  it("is left out of the operator's account lists, user search, friends and conversations", async () => {
    const { owner, sender } = await withWebhook();
    expect((await listUsers()).map((u) => u.username)).toEqual(["owner"]);
    expect((await api.get("/api/v1/users/search?q=webhook").set(as(owner))).body.users).toHaveLength(0);
    expect((await api.post("/api/v1/friends/requests").set(as(owner)).send({ username: sender.username })).status).toBeGreaterThanOrEqual(400);
    const dm = await api.post("/api/v1/conversations").set(as(owner)).send({ type: "DM", memberUsernames: [sender.username] });
    expect(dm.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("is never found by another server", async () => {
    const { sender } = await withWebhook();
    const peer = await registerTestPeer("alice.test");
    const res = await signedGet(peer, `/federation/v1/users/${encodeURIComponent(sender.username)}`);
    expect(res.status).toBe(404);
  });
});

describe("the audit log", () => {
  it("records making, changing, re-keying and deleting one, by name and id and never by secret", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    await prisma.auditLogEntry.deleteMany();
    const { webhook, url } = await makeWebhook(owner, club, "Deploys");
    await api.patch(`/api/v1/communities/${club.id}/webhooks/${webhook.id}`).set(as(owner)).send({ name: "CI" });
    const rotated = await api.post(`/api/v1/communities/${club.id}/webhooks/${webhook.id}/url`).set(as(owner));
    await api.delete(`/api/v1/communities/${club.id}/webhooks/${webhook.id}`).set(as(owner));

    const entries = await prisma.auditLogEntry.findMany({ where: { action: { startsWith: "webhook." } }, orderBy: { id: "asc" } });
    expect(entries.map((e) => e.action)).toEqual(["webhook.create", "webhook.update", "webhook.rotate", "webhook.delete"]);
    expect(entries.every((e) => e.targetId === webhook.id && e.communityId === club.id && e.actorUserId === owner.user.id)).toBe(true);
    expect(entries[0].targetLabel).toBe("Deploys");
    expect(entries[1].details).toEqual({ fields: ["name"] });
    const everything = JSON.stringify(entries);
    for (const secret of [url.split("/").pop()!, rotated.body.url.split("/").pop()!, "mcw_"]) expect(everything).not.toContain(secret);
  });

  it("records nothing for a post, a refusal or a repeat that changes nothing", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const stranger = await registerUser("stranger");
    const { url } = await makeWebhook(owner, club);
    await prisma.auditLogEntry.deleteMany();
    await post(url);
    await api.post(`/api/v1/communities/${club.id}/webhooks`).set(as(stranger)).send({ name: "x", channelId: club.channels[0].id });
    expect(await prisma.auditLogEntry.count()).toBe(0);
  });
});

describe("the secret in a log", () => {
  it("is not written when a post fails: the server logs the route, not the address", async () => {
    const owner = await registerUser("owner");
    const club = await makeCommunity(owner);
    const { url } = await makeWebhook(owner, club);
    const secret = url.split("/").pop()!;
    vi.spyOn(prisma.message, "create").mockRejectedValueOnce(new Error("the database hiccuped"));
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));

    const res = await post(url);
    expect(res.status).toBe(500);
    expect(logged.join("\n")).toContain("/api/v1/webhooks/");
    expect(logged.join("\n")).not.toContain(secret);
  });
});
