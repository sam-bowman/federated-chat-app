// Link previews (#197), end to end against a real database and a small web server on this machine: what is read and when, what is
// refused, what is kept and told to people, and what another server may tell this one. The fetch guard normally refuses a server on
// this machine, so these tests turn it off (`testHooks.allowPrivate`) where they need a page, and leave it on where they check it.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { READ_LIMITS, resetLimitsForTests, testHooks } from "../../src/modules/linkPreview/service.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;

// --- a web server to be linked to
let server: http.Server;
let base: string;
const hits: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/missing") return void res.writeHead(404, { "Content-Type": "text/html" }).end("nope");
    if (path === "/json") return void res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    if (path === "/empty") return void res.writeHead(200, { "Content-Type": "text/html" }).end("<html><body>no head</body></html>");
    const n = path.replace(/\D/g, "") || "0";
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end(`<html><head><title>Page ${n}</title><meta property="og:description" content="About page ${n}"><meta property="og:site_name" content="Test Site"></head><body></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  hits.length = 0;
  config.linkPreviewsEnabled = true;
  testHooks.allowPrivate = true;
  resetLimitsForTests();
});
afterEach(() => {
  config.linkPreviewsEnabled = false;
  testHooks.allowPrivate = false;
});

// --- helpers
const row = (user: Registered) => prisma.user.findUniqueOrThrow({ where: { protocolId: user.user.id } });
async function community(owner: Registered) {
  const created = (await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name: "Club" })).body.community;
  return created as { id: string; channels: { id: string }[] };
}
async function dm(from: Registered, to: string) {
  return (await api.post("/api/v1/conversations").set(authHeader(from.accessToken)).send({ type: "DM", memberUsernames: [to] })).body.conversation.id as string;
}
const sendToChannel = (user: Registered, channelId: string, content: string) => api.post(`/api/v1/channels/${channelId}/messages`).set(authHeader(user.accessToken)).send({ content });
const sendToChat = (user: Registered, id: string, content: string) => api.post(`/api/v1/conversations/${id}/messages`).set(authHeader(user.accessToken)).send({ content });
async function until<T>(read: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}
const embedsOf = async (messageId: string) => (await prisma.message.findUniqueOrThrow({ where: { protocolId: messageId } })).embeds as { url: string; title: string | null }[] | null;
const waitForEmbeds = (messageId: string) => until(async () => ((await embedsOf(messageId))?.length ? embedsOf(messageId) : null));
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const eventsFor = async (user: Registered, type: string) => prisma.syncEvent.findMany({ where: { recipientId: (await row(user)).id, type } });

describe("a message with a link", () => {
  it("is sent at once, and then gets a preview with the page's title, description and site, which the members are told", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await community(alice);
    await api.post(`/api/v1/communities/${club.id}/members`).set(authHeader(bob.accessToken));

    const sent = await sendToChannel(alice, club.channels[0].id, `look at ${base}/page1 please`);
    expect(sent.status).toBe(201);
    expect(sent.body.message.embeds).toEqual([]); // the answer does not wait for the page

    const embeds = await waitForEmbeds(sent.body.message.id);
    expect(embeds).toEqual([{ url: `${base}/page1`, title: "Page 1", description: "About page 1", siteName: "Test Site" }]);

    // Everyone in the channel is told, the sender included (their own client has only the answer above).
    for (const person of [alice, bob]) {
      const events = await until(async () => {
        const found = await eventsFor(person, "message:embeds");
        return found.length > 0 ? found : null;
      });
      expect(events[0].payload).toMatchObject({ messageId: sent.body.message.id, channelId: club.channels[0].id, embeds: [expect.objectContaining({ title: "Page 1" })] });
    }
    // And it is what the message is read back as.
    const history = await api.get(`/api/v1/channels/${club.channels[0].id}/messages`).set(authHeader(bob.accessToken));
    expect(history.body.messages[0].embeds).toEqual(embeds);
  });

  it("works the same in a direct chat", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const chat = await dm(alice, "bob");
    const sent = await sendToChat(alice, chat, `${base}/page2`);
    await waitForEmbeds(sent.body.message.id);
    const list = await api.get(`/api/v1/conversations/${chat}/messages`).set(authHeader(bob.accessToken));
    expect(list.body.messages[0].embeds[0]).toMatchObject({ title: "Page 2" });
    expect((await eventsFor(bob, "message:embeds"))[0].payload).toMatchObject({ conversationId: chat });
  });

  it("reads each page once however many times it is linked, and a page with no more than three links per message", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const a = await sendToChannel(alice, club.channels[0].id, `${base}/page5`);
    await waitForEmbeds(a.body.message.id);
    const b = await sendToChannel(alice, club.channels[0].id, `again ${base}/page5`);
    await waitForEmbeds(b.body.message.id);
    expect(hits.filter((h) => h === "/page5"), "read once, then remembered").toHaveLength(1);

    hits.length = 0;
    const many = await sendToChannel(alice, club.channels[0].id, [1, 2, 3, 4, 5, 6].map((n) => `${base}/page1${n}`).join(" "));
    await until(async () => ((await embedsOf(many.body.message.id))?.length === 3 ? true : null));
    await settle();
    expect(hits).toHaveLength(3);
    expect((await embedsOf(many.body.message.id))!.map((e) => e.title)).toEqual(["Page 11", "Page 12", "Page 13"]);
  });

  it("gets no preview, and no error, from a page that is missing, is not HTML, or has nothing to show", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    for (const path of ["/missing", "/json", "/empty"]) {
      const sent = await sendToChannel(alice, club.channels[0].id, `${base}${path}`);
      expect(sent.status, path).toBe(201);
      await until(async () => (hits.includes(path) ? true : null));
      await settle(200);
      expect(await embedsOf(sent.body.message.id), path).toBeNull();
    }
    // Remembered, for a shorter time: not asked again at once.
    hits.length = 0;
    await sendToChannel(alice, club.channels[0].id, `${base}/missing`);
    await settle(300);
    expect(hits).toEqual([]);
  });

  it("never makes the server ask for a private address, and says nothing about it", async () => {
    testHooks.allowPrivate = false; // as on a real server
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page1 http://169.254.169.254/latest/meta-data http://localhost/x http://10.0.0.1/a`);
    expect(sent.status).toBe(201);
    await settle(500);
    expect(hits, "no request reached the local server").toEqual([]);
    expect(await embedsOf(sent.body.message.id)).toBeNull();
  });

  it("is not read for an invitation card, or once the message is deleted", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await community(alice);
    await api.post(`/api/v1/communities/${club.id}/members`).set(authHeader(bob.accessToken));
    const chat = await dm(alice, "bob");
    const card = await api.post(`/api/v1/conversations/${chat}/messages`).set(authHeader(alice.accessToken)).send({ invite: { communityId: club.id } });
    expect(card.status).toBe(201);
    await settle(300);
    expect(await embedsOf(card.body.message.id)).toBeNull();
    expect(hits).toEqual([]);

    const sent = await sendToChat(alice, chat, `${base}/page9`);
    await waitForEmbeds(sent.body.message.id);
    await api.delete(`/api/v1/messages/${sent.body.message.id}`).set(authHeader(alice.accessToken));
    const list = await api.get(`/api/v1/conversations/${chat}/messages`).set(authHeader(bob.accessToken));
    expect(list.body.messages.find((m: { id: string }) => m.id === sent.body.message.id).embeds).toEqual([]);
  });
});

describe("the limits", () => {
  it("allow one person only so many page reads in a while, however they send them", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const total = READ_LIMITS.perUser + 4;
    for (let n = 0; n < total; n += 3) {
      await sendToChannel(alice, club.channels[0].id, [0, 1, 2].map((k) => `${base}/page2${n + k}`).join(" "));
    }
    await settle(1500);
    expect(hits.length).toBeLessThanOrEqual(READ_LIMITS.perUser);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("do not stop another person, and a page already remembered costs nobody anything", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await community(alice);
    await api.post(`/api/v1/communities/${club.id}/members`).set(authHeader(bob.accessToken));
    for (let n = 0; n < READ_LIMITS.perUser + 3; n += 3) await sendToChannel(alice, club.channels[0].id, [0, 1, 2].map((k) => `${base}/page3${n + k}`).join(" "));
    await settle(1500);
    hits.length = 0;
    const mine = await sendToChannel(bob, club.channels[0].id, `${base}/page400`);
    await waitForEmbeds(mine.body.message.id);
    // Alice is over her limit but a page Bob already had read for him is remembered for everyone.
    const again = await sendToChannel(alice, club.channels[0].id, `${base}/page400`);
    await waitForEmbeds(again.body.message.id);
    expect(hits.filter((h) => h === "/page400")).toHaveLength(1);
  });
});

describe("the switch", () => {
  it("is off until the operator turns it on: nothing is read, nothing is stored, nothing is shown", async () => {
    config.linkPreviewsEnabled = false;
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page1`);
    await settle(400);
    expect(hits).toEqual([]);
    expect(await embedsOf(sent.body.message.id)).toBeNull();
  });

  it("hides previews it already holds when it is turned off, and shows them again when it is turned back on", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page1`);
    await waitForEmbeds(sent.body.message.id);
    config.linkPreviewsEnabled = false;
    const off = await api.get(`/api/v1/channels/${club.channels[0].id}/messages`).set(authHeader(alice.accessToken));
    expect(off.body.messages[0].embeds).toEqual([]);
    config.linkPreviewsEnabled = true;
    const on = await api.get(`/api/v1/channels/${club.channels[0].id}/messages`).set(authHeader(alice.accessToken));
    expect(on.body.messages[0].embeds).toHaveLength(1);
  });

  it("is said in the discovery document, so a client knows whether to look", async () => {
    expect((await api.get("/.well-known/communication-platform")).body.features.linkPreviews).toBe(true);
    config.linkPreviewsEnabled = false;
    expect((await api.get("/.well-known/communication-platform")).body.features.linkPreviews).toBe(false);
  });
});

describe("editing and removing", () => {
  it("an edit takes off a preview for a link that is gone at once, and reads a new one", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page1`);
    await waitForEmbeds(sent.body.message.id);

    await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(authHeader(alice.accessToken)).send({ content: "never mind" });
    await until(async () => ((await embedsOf(sent.body.message.id)) === null ? true : null));

    await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(authHeader(alice.accessToken)).send({ content: `now ${base}/page7` });
    const embeds = await until(async () => ((await embedsOf(sent.body.message.id))?.length ? embedsOf(sent.body.message.id) : null));
    expect(embeds![0].title).toBe("Page 7");
  });

  it("the author can take the previews off, for everyone, and an edit does not bring them back", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await community(alice);
    await api.post(`/api/v1/communities/${club.id}/members`).set(authHeader(bob.accessToken));
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page1`);
    await waitForEmbeds(sent.body.message.id);

    expect((await api.delete(`/api/v1/messages/${sent.body.message.id}/embeds`).set(authHeader(bob.accessToken))).status).toBe(403);
    expect((await embedsOf(sent.body.message.id))!.length).toBe(1);

    expect((await api.delete(`/api/v1/messages/${sent.body.message.id}/embeds`).set(authHeader(alice.accessToken))).status).toBe(204);
    expect(await embedsOf(sent.body.message.id)).toBeNull();
    const told = await eventsFor(bob, "message:embeds");
    expect(told[told.length - 1].payload).toMatchObject({ messageId: sent.body.message.id, embeds: [] });

    await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(authHeader(alice.accessToken)).send({ content: `${base}/page8 instead` });
    await settle(500);
    expect(await embedsOf(sent.body.message.id)).toBeNull();
  });

  it("asks for a sign-in, and finds no message that is not there", async () => {
    const alice = await registerUser("alice");
    expect((await api.delete("/api/v1/messages/nosuch/embeds")).status).toBe(401);
    expect((await api.delete("/api/v1/messages/nosuch/embeds").set(authHeader(alice.accessToken))).status).toBe(404);
  });
});

describe("other servers", () => {
  async function remoteChat() {
    const alice = await registerUser("alice");
    const far = await registerTestPeer("far.test");
    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: "far.test", isRemote: true } });
    const aliceRow = await row(alice);
    const conversation = await prisma.conversation.create({
      data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: aliceRow.id }, { userId: remy.id }] } },
    });
    return { alice, far, remy, conversation };
  }
  const remoteMessage = (conversationId: string, senderId: string) => prisma.message.create({ data: { protocolId: newProtocolId(), conversationId, senderId, content: "from far away" } });

  it("tells a server that has someone in the chat what the previews are, after the message", async () => {
    const { alice, conversation } = await remoteChat();
    // A message into a chat with someone on another server: the other server would have it already.
    const sent = await api.post(`/api/v1/conversations/${conversation.protocolId}/messages`).set(authHeader(alice.accessToken)).send({ content: `${base}/page1` }).catch(() => null);
    expect(sent?.status).toBe(201);
    await waitForEmbeds(sent!.body.message.id);
    const queued = await until(async () => {
      const rows = await prisma.federationOutboxEvent.findMany({ where: { path: `/messages/${sent!.body.message.id}/embeds` } });
      return rows.length > 0 ? rows : null;
    });
    expect(queued[0].domain).toBe("far.test");
    expect(queued[0].body).toMatchObject({ embeds: [expect.objectContaining({ url: `${base}/page1`, title: "Page 1" })] });
  });

  it("does not read pages for what someone on another server wrote: their server does", async () => {
    const { alice, remy, conversation } = await remoteChat();
    const message = await remoteMessage(conversation.protocolId ? (await prisma.conversation.findUniqueOrThrow({ where: { protocolId: conversation.protocolId } })).id : "", remy.id);
    await prisma.message.update({ where: { id: message.id }, data: { content: `${base}/page1` } });
    const { generateEmbeds } = await import("../../src/modules/linkPreview/service.js");
    await generateEmbeds(message.protocolId);
    expect(hits).toEqual([]);
    expect(alice).toBeTruthy();
  });

  it("takes previews from the message's own server, checked: only plain http(s) previews, cut to length, no more than three", async () => {
    const { alice, far, remy, conversation } = await remoteChat();
    const message = await remoteMessage(conversation.id, remy.id);
    const res = await signedPost(far, `/federation/v1/messages/${message.protocolId}/embeds`, {
      embeds: [
        { url: "https://example.com/a", title: "A".repeat(1000), description: "d", siteName: "S", imageUrl: "https://evil.example/x.png" },
        { url: "javascript:alert(1)", title: "bad address" },
        { url: "https://paypal.com@evil.example/", title: "name and password" },
        { url: "https://example.com/c" },
        { url: "https://example.com/d", title: "D" },
        { url: "https://example.com/e", title: "E" },
        { url: "https://example.com/f", title: "F" },
      ],
    });
    expect(res.status).toBe(204);
    const stored = (await embedsOf(message.protocolId))!;
    expect(stored.map((e) => e.url)).toEqual(["https://example.com/a", "https://example.com/d", "https://example.com/e"]);
    expect([...stored[0].title!].length).toBe(150);
    expect(Object.keys(stored[0]).sort()).toEqual(["description", "siteName", "title", "url"]);
    const told = await eventsFor(alice, "message:embeds");
    expect(told[0].payload).toMatchObject({ messageId: message.protocolId, conversationId: conversation.protocolId });
  });

  it("takes them from nobody else: not another server, not for one of this server's own messages", async () => {
    const { alice, remy, conversation } = await remoteChat();
    const other = await registerTestPeer("other.test");
    const message = await remoteMessage(conversation.id, remy.id);
    expect((await signedPost(other, `/federation/v1/messages/${message.protocolId}/embeds`, { embeds: [{ url: "https://example.com/", title: "x" }] })).status).toBe(403);
    expect(await embedsOf(message.protocolId)).toBeNull();

    const mine = await sendToChat(alice, conversation.protocolId, "hello").catch(() => null);
    const far = await registerTestPeer("far.test");
    expect((await signedPost(far, `/federation/v1/messages/${mine?.body.message.id}/embeds`, { embeds: [{ url: "https://example.com/", title: "x" }] })).status).toBe(403);
    expect((await signedPost(far, "/federation/v1/messages/nosuch/embeds", { embeds: [] })).status).toBe(404);
    expect((await signedPost(far, `/federation/v1/messages/${message.protocolId}/embeds`, { nope: true })).status).toBe(400);
  });

  it("ignores them on a server that does no previews, so 'off' means no cards at all", async () => {
    const { far, remy, conversation } = await remoteChat();
    const message = await remoteMessage(conversation.id, remy.id);
    config.linkPreviewsEnabled = false;
    const res = await signedPost(far, `/federation/v1/messages/${message.protocolId}/embeds`, { embeds: [{ url: "https://example.com/", title: "x" }] });
    expect(res.status).toBe(204);
    expect(await embedsOf(message.protocolId)).toBeNull();
  });
});
