// A bot's cards (#132, phase 3a, docs/commands-design.md), end to end against a real database, the real storage driver and a small web server
// on this machine: what a bot may send and what it is told when it is wrong, what is stored, shown and relayed, how its pictures are fetched and
// kept (and not shown to anyone while pictures are off), what an edit does to them, and what another server's cards are held to on arrival.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { cleanRichEmbeds } from "../../src/lib/richEmbed.js";
import { IMAGE_STORE_LIMITS, pruneImages, resetImageLimitsForTests } from "../../src/modules/linkPreview/images.js";
import { resetLimitsForTests, testHooks } from "../../src/modules/linkPreview/service.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
const as = (user: Registered) => authHeader(user.accessToken);

function png(width: number, height: number, total = 300): Buffer {
  const b = Buffer.alloc(Math.max(total, 33), 9);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const PICTURE = png(640, 480);

// --- a web server for the pictures a bot names
let server: http.Server;
let base: string;
const hits: string[] = [];
let openGate: () => void = () => undefined;
let gate: Promise<void> = Promise.resolve();
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const route = (req.url ?? "/").split("?")[0];
    if (route.endsWith(".png") && route !== "/lie.png" && route !== "/gate.png") return void res.writeHead(200, { "Content-Type": "image/png" }).end(PICTURE);
    if (route === "/lie.png") return void res.writeHead(200, { "Content-Type": "image/png" }).end("<html><script>alert(1)</script></html>");
    // Held until the test lets it go, so a test can do something while a picture is on its way.
    if (route === "/gate.png") return void gate.then(() => res.writeHead(200, { "Content-Type": "image/png" }).end(PICTURE));
    res.writeHead(404, { "Content-Type": "text/html" }).end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(async () => {
  await resetDb();
  hits.length = 0;
  gate = new Promise<void>((resolve) => (openGate = resolve));
  config.linkPreviewsEnabled = false;
  config.linkPreviewImagesEnabled = false;
  testHooks.allowPrivate = true;
  resetLimitsForTests();
  resetImageLimitsForTests();
});
afterEach(async () => {
  openGate();
  // Take the files away too (they are not in the database), the way switching pictures off does.
  config.linkPreviewImagesEnabled = false;
  await pruneImages();
  config.linkPreviewsEnabled = false;
  testHooks.allowPrivate = false;
});

const picturesOn = () => {
  config.linkPreviewsEnabled = true;
  config.linkPreviewImagesEnabled = true;
};

// --- helpers
async function until<T>(read: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

async function setup() {
  const owner = await registerUser("owner");
  const made = await api.post("/api/v1/bots").set(as(owner)).send({ username: "robo" });
  expect(made.status).toBe(201);
  const bot = { Authorization: `Bot ${made.body.token}` };
  const community = (await api.post("/api/v1/communities").set(as(owner)).send({ name: "Club" })).body.community as { id: string; channels: { id: string }[] };
  expect((await api.post(`/api/v1/communities/${community.id}/bots`).set(as(owner)).send({ username: "robo" })).status).toBe(201);
  const reader = await registerUser("reader");
  await api.post(`/api/v1/communities/${community.id}/members`).set(as(reader));
  const channelId = community.channels[0].id;
  const botRow = await prisma.user.findFirstOrThrow({ where: { username: "robo" } });
  return { owner, bot, botId: made.body.bot.id as string, botRow, reader, community, channelId };
}

type Setup = Awaited<ReturnType<typeof setup>>;
type Card = { title: string | null; description: string | null; url: string | null; color: string | null; fields: { name: string; value: string; inline: boolean }[]; footer: string | null; image?: { url: string; width: number; height: number }; thumbnail?: { url: string; width: number; height: number } };

const sendCards = (s: Setup, body: Record<string, unknown>) => api.post(`/api/v1/channels/${s.channelId}/messages`).set(s.bot).send(body);
const history = async (s: Setup, as_: Registered = s.reader) =>
  (await api.get(`/api/v1/channels/${s.channelId}/messages`).set(as(as_))).body.messages as { id: string; content: string | null; richEmbeds: Card[]; editedAt: string | null }[];
const stored = async (messageId: string) => (await prisma.message.findUniqueOrThrow({ where: { protocolId: messageId } }));
const events = (user: Registered, type: string) => prisma.syncEvent.findMany({ where: { type, recipient: { protocolId: user.user.id } }, orderBy: { seq: "asc" } });

describe("a bot sends cards", () => {
  it("sends a message that is only a card: no text, a card with its parts, shown live to members and in the history", async () => {
    const s = await setup();
    const sent = await sendCards(s, {
      embeds: [{ title: "Dune", description: "A 2021 film.\nDirected by Denis Villeneuve.", url: "https://example.com/dune", color: "#AABBCC", fields: [{ name: "Year", value: "2021", inline: true }], footer: "via robo" }],
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message.content).toBe("");
    expect(sent.body.message.richEmbeds).toEqual([
      { title: "Dune", description: "A 2021 film.\nDirected by Denis Villeneuve.", url: "https://example.com/dune", color: "#aabbcc", fields: [{ name: "Year", value: "2021", inline: true }], footer: "via robo" },
    ]);

    expect(await history(s)).toEqual([expect.objectContaining({ content: "", richEmbeds: [expect.objectContaining({ title: "Dune" })] })]);
    const live = await events(s.reader, "message:created");
    expect(live).toHaveLength(1);
    expect((live[0].payload as { message: { richEmbeds: Card[] } }).message.richEmbeds[0].title).toBe("Dune");
  });

  it("sends text and a card together, and an ordinary message has no cards", async () => {
    const s = await setup();
    const both = await sendCards(s, { content: "Found it:", embeds: [{ title: "Dune" }] });
    expect(both.status).toBe(201);
    expect(both.body.message).toMatchObject({ content: "Found it:", richEmbeds: [expect.objectContaining({ title: "Dune" })] });
    const plain = await sendCards(s, { content: "just text" });
    expect(plain.body.message.richEmbeds).toEqual([]);
    expect((await stored(plain.body.message.id)).richEmbeds).toBeNull();
  });

  it("cleans what it was given: controls and bidi marks go, a bad address or colour is dropped, unknown keys are ignored", async () => {
    const s = await setup();
    const sent = await sendCards(s, {
      embeds: [{ title: "Du‮ne\u0000", description: "  a \t b  ", url: "javascript:alert(1)", color: "red", footer: "https://user:pw@example.com", surprise: true, fields: [{ name: "n", value: "v" }] }],
    });
    expect(sent.status).toBe(201);
    expect(sent.body.message.richEmbeds[0]).toEqual({ title: "Dune", description: "a b", url: null, color: null, fields: [{ name: "n", value: "v", inline: false }], footer: "https://user:pw@example.com" });
  });

  it.each([
    ["a title over its limit", { embeds: [{ title: "t".repeat(151) }] }, "invalid_embeds"],
    ["a description over its limit", { embeds: [{ description: "d".repeat(1501) }] }, "invalid_embeds"],
    ["a card with nothing to show", { embeds: [{ url: "https://example.com", color: "#112233" }] }, "invalid_embeds"],
    ["a card that is only a picture", { embeds: [{ image: "https://example.com/a.png" }] }, "invalid_embeds"],
    ["cards whose words together are over the limit", { embeds: [1, 2, 3].map((n) => ({ title: `Card ${n}`, description: "d".repeat(1500) })) }, "embeds_too_large"],
  ])("tells its author when it sends %s, and writes nothing", async (_name, body, error) => {
    const s = await setup();
    const res = await sendCards(s, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(await prisma.message.count()).toBe(0);
  });

  it.each([
    ["more than three cards", { embeds: [1, 2, 3, 4].map((n) => ({ title: `Card ${n}` })) }],
    ["more than ten fields", { embeds: [{ title: "t", fields: Array.from({ length: 11 }, () => ({ name: "n", value: "v" })) }] }],
    ["cards of the wrong type", { embeds: "nope" }],
    ["a title that is not text", { embeds: [{ title: 5 }] }],
    ["nothing at all", {}],
    ["empty text and no cards", { content: "" }],
    ["empty text and an empty list", { content: "", embeds: [] }],
  ])("refuses %s as an invalid request", async (_name, body) => {
    const s = await setup();
    const res = await sendCards(s, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(await prisma.message.count()).toBe(0);
  });

  it("is for bots: a person's request with cards is refused, and so is a person's edit", async () => {
    const s = await setup();
    const own = await api.post(`/api/v1/channels/${s.channelId}/messages`).set(as(s.owner)).send({ content: "hello" });
    const withCards = await api.post(`/api/v1/channels/${s.channelId}/messages`).set(as(s.owner)).send({ content: "hi", embeds: [{ title: "x" }] });
    expect(withCards.status).toBe(403);
    expect(withCards.body.error).toBe("embeds_bots_only");
    const edit = await api.patch(`/api/v1/messages/${own.body.message.id}`).set(as(s.owner)).send({ embeds: [{ title: "x" }] });
    expect(edit.status).toBe(403);
    // A person still needs text to edit with, as always.
    expect((await api.patch(`/api/v1/messages/${own.body.message.id}`).set(as(s.owner)).send({ content: "" })).status).toBe(400);
    expect((await api.patch(`/api/v1/messages/${own.body.message.id}`).set(as(s.owner)).send({})).status).toBe(400);
    expect((await api.patch(`/api/v1/messages/${own.body.message.id}`).set(as(s.owner)).send({ content: "edited" })).status).toBe(200);
  });

  it("a card is not shown from a message that was deleted", async () => {
    const s = await setup();
    const sent = await sendCards(s, { embeds: [{ title: "Dune" }] });
    expect((await api.delete(`/api/v1/messages/${sent.body.message.id}`).set(s.bot)).status).toBe(204);
    const [message] = await history(s);
    expect(message.richEmbeds).toEqual([]);
  });
});

describe("editing a card", () => {
  it("replaces the cards and leaves the text, takes them off with an empty list, and marks the message edited", async () => {
    const s = await setup();
    const sent = await sendCards(s, { content: "Found it:", embeds: [{ title: "Dune" }] });
    const id = sent.body.message.id as string;

    const changed = await api.patch(`/api/v1/messages/${id}`).set(s.bot).send({ embeds: [{ title: "Dune: Part Two", fields: [{ name: "Year", value: "2024" }] }] });
    expect(changed.status).toBe(200);
    expect(changed.body.message).toMatchObject({ content: "Found it:", richEmbeds: [expect.objectContaining({ title: "Dune: Part Two" })] });
    expect(changed.body.message.editedAt).not.toBeNull();

    const removed = await api.patch(`/api/v1/messages/${id}`).set(s.bot).send({ embeds: [] });
    expect(removed.status).toBe(200);
    expect(removed.body.message).toMatchObject({ content: "Found it:", richEmbeds: [] });
    expect((await stored(id)).richEmbeds).toBeNull();
  });

  it("changes the text and keeps the cards when only the text is sent", async () => {
    const s = await setup();
    const sent = await sendCards(s, { content: "first", embeds: [{ title: "Dune" }] });
    const changed = await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(s.bot).send({ content: "second" });
    expect(changed.body.message).toMatchObject({ content: "second", richEmbeds: [expect.objectContaining({ title: "Dune" })] });
  });

  it("will not leave a message with neither text nor a card, and refuses bad cards as sending does", async () => {
    const s = await setup();
    const sent = await sendCards(s, { embeds: [{ title: "Dune" }] });
    const id = sent.body.message.id as string;
    const nothing = await api.patch(`/api/v1/messages/${id}`).set(s.bot).send({ embeds: [] });
    expect(nothing.status).toBe(400);
    expect((await api.patch(`/api/v1/messages/${id}`).set(s.bot).send({ embeds: [{ title: "t".repeat(151) }] })).body.error).toBe("invalid_embeds");
    expect((await api.patch(`/api/v1/messages/${id}`).set(s.bot).send({ embeds: [{ url: "https://example.com" }] })).body.error).toBe("invalid_embeds");
    // Still as it was.
    expect((await history(s))[0].richEmbeds[0].title).toBe("Dune");
  });

  it("is the sender's alone: another bot, or a manager, cannot change the cards", async () => {
    const s = await setup();
    const sent = await sendCards(s, { embeds: [{ title: "Dune" }] });
    const other = await api.post("/api/v1/bots").set(as(s.owner)).send({ username: "other" });
    await api.post(`/api/v1/communities/${s.community.id}/bots`).set(as(s.owner)).send({ username: "other" });
    const otherBot = { Authorization: `Bot ${other.body.token}` };
    expect((await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(otherBot).send({ embeds: [{ title: "Mine" }] })).status).toBe(403);
    expect((await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(as(s.owner)).send({ content: "mine" })).status).toBe(403);
  });
});

describe("what is relayed to other servers", () => {
  async function withRemoteMember(s: Setup) {
    const row = await prisma.community.findFirstOrThrow({ where: { protocolId: s.community.id } });
    const far = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "far", displayName: "far", homeserverDomain: "far.test", isRemote: true } });
    await prisma.communityMember.create({ data: { communityId: row.id, userId: far.id } });
  }
  const sentTo = (path: string) => prisma.federationOutboxEvent.findMany({ where: { domain: "far.test", path: { contains: path } }, orderBy: { createdAt: "asc" } });

  it("carries the cards and, for a message that is only cards, a plain-text stand-in a server that predates cards can show", async () => {
    const s = await setup();
    await withRemoteMember(s);
    await sendCards(s, { embeds: [{ title: "Dune", description: "A film" }] });
    await sendCards(s, { content: "Found it:", embeds: [{ title: "Dune" }] });
    await sendCards(s, { content: "no cards" });
    const bodies = (await sentTo("/messages")).map((e) => e.body as { content: string; richEmbeds?: Card[] });
    expect(bodies[0]).toMatchObject({ content: "Dune", richEmbeds: [expect.objectContaining({ title: "Dune", description: "A film" })] });
    expect(bodies[1]).toMatchObject({ content: "Found it:", richEmbeds: [expect.objectContaining({ title: "Dune" })] });
    expect(bodies[2].content).toBe("no cards");
    expect(bodies[2]).not.toHaveProperty("richEmbeds");
  });

  it("carries a changed card as an edit, and an edit of the text alone does not touch the cards", async () => {
    const s = await setup();
    await withRemoteMember(s);
    const sent = await sendCards(s, { content: "first", embeds: [{ title: "Dune" }] });
    await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(s.bot).send({ embeds: [{ title: "Part Two" }] });
    await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(s.bot).send({ content: "second" });
    const edits = (await sentTo("/edit")).map((e) => e.body as { content: string; richEmbeds?: Card[] });
    expect(edits[0]).toMatchObject({ content: "first", richEmbeds: [expect.objectContaining({ title: "Part Two" })] });
    expect(edits[1].content).toBe("second");
    expect(edits[1]).not.toHaveProperty("richEmbeds");
  });

  it("sends an edit that leaves a message only cards with the stand-in text, and an empty list when they are taken off", async () => {
    const s = await setup();
    await withRemoteMember(s);
    const sent = await sendCards(s, { content: "text", embeds: [{ title: "Dune" }] });
    await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(s.bot).send({ content: "" });
    await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(s.bot).send({ content: "back", embeds: [] });
    const edits = (await sentTo("/edit")).map((e) => e.body as { content: string; richEmbeds?: Card[] });
    expect(edits[0]).toMatchObject({ content: "Dune" });
    expect(edits[1]).toMatchObject({ content: "back", richEmbeds: [] });
  });
});

describe("a bot's pictures", () => {
  const first = (card: Card | undefined) => card as Card;

  it("are copied once by the server after the answer, the card is announced again with the copy, and readers see the copy and never the bot's address", async () => {
    picturesOn();
    const s = await setup();
    const sent = await sendCards(s, { embeds: [{ title: "Dune", image: `${base}/poster.png`, thumbnail: `${base}/thumb.png` }] });
    expect(sent.status).toBe(201);
    // The answer, and the first announcement, have the card without its pictures.
    expect(first(sent.body.message.richEmbeds[0]).image).toBeUndefined();

    const done = await until(async () => {
      const card = (await history(s))[0].richEmbeds[0];
      return card.image && card.thumbnail ? card : null;
    });
    expect(done.image).toMatchObject({ width: 640, height: 480 });
    expect(done.image!.url.startsWith(config.baseUrl)).toBe(true);
    expect(done.image!.url).not.toContain("127.0.0.1");
    expect(hits.sort()).toEqual(["/poster.png", "/thumb.png"]);

    // Announced again, with the copies, as the event the previews use.
    const announced = await until(async () => {
      const list = await events(s.reader, "message:embeds");
      return list.length > 0 ? list : null;
    });
    const payload = announced[announced.length - 1].payload as { messageId: string; richEmbeds: Card[] };
    expect(payload.messageId).toBe(sent.body.message.id);
    expect(payload.richEmbeds[0].image?.url).toBe(done.image!.url);
  });

  it("are not fetched, and the card is shown without them, while the server has pictures off", async () => {
    const s = await setup();
    await sendCards(s, { embeds: [{ title: "Dune", image: `${base}/poster.png` }] });
    await new Promise((r) => setTimeout(r, 200));
    expect(hits).toEqual([]);
    expect((await history(s))[0].richEmbeds).toEqual([expect.objectContaining({ title: "Dune" })]);
    expect((await history(s))[0].richEmbeds[0].image).toBeUndefined();
  });

  it("are shown only while pictures are on: switching them off takes them off the card (and a card that was only a picture would go)", async () => {
    picturesOn();
    const s = await setup();
    await sendCards(s, { embeds: [{ title: "Dune", image: `${base}/poster.png` }] });
    await until(async () => (await history(s))[0].richEmbeds[0].image);
    config.linkPreviewImagesEnabled = false;
    const [message] = await history(s);
    expect(message.richEmbeds).toHaveLength(1);
    expect(message.richEmbeds[0].image).toBeUndefined();
    expect(message.richEmbeds[0].title).toBe("Dune");
  });

  it("leave the card as it is when the picture is not a picture, whatever the other site claims", async () => {
    picturesOn();
    const s = await setup();
    await sendCards(s, { embeds: [{ title: "Dune", image: `${base}/lie.png` }] });
    await until(async () => hits.includes("/lie.png"));
    await new Promise((r) => setTimeout(r, 200));
    expect((await history(s))[0].richEmbeds[0].image).toBeUndefined();
    expect(await prisma.linkPreviewImage.count()).toBe(0);
  });

  it("do not reach a machine the guard refuses, and an address that is not http(s) is never fetched", async () => {
    picturesOn();
    testHooks.allowPrivate = false;
    const s = await setup();
    await sendCards(s, { embeds: [{ title: "Dune", image: `${base}/poster.png`, thumbnail: "file:///etc/passwd" }] });
    await new Promise((r) => setTimeout(r, 300));
    expect(hits).toEqual([]);
    expect((await history(s))[0].richEmbeds[0].image).toBeUndefined();
  });

  it("cost each bot an allowance of its own, so one bot's cards cannot use up another's, nor the previews'", async () => {
    picturesOn();
    const limits = IMAGE_STORE_LIMITS as { perBotPerHour: number };
    const before = limits.perBotPerHour;
    limits.perBotPerHour = 2;
    try {
      const s = await setup();
      const other = await api.post("/api/v1/bots").set(as(s.owner)).send({ username: "other" });
      await api.post(`/api/v1/communities/${s.community.id}/bots`).set(as(s.owner)).send({ username: "other" });
      const otherBot = { Authorization: `Bot ${other.body.token}` };

      for (const n of [1, 2, 3]) await sendCards(s, { embeds: [{ title: `Card ${n}`, image: `${base}/p${n}.png` }] });
      await until(async () => (await history(s)).filter((m) => m.richEmbeds[0].image).length >= 2);
      await new Promise((r) => setTimeout(r, 300));
      expect((await history(s)).filter((m) => m.richEmbeds[0].image)).toHaveLength(2); // the third had no allowance left
      expect(hits).toHaveLength(2);

      // The other bot is not held to the first one's use.
      await api.post(`/api/v1/channels/${s.channelId}/messages`).set(otherBot).send({ embeds: [{ title: "Other", image: `${base}/p9.png` }] });
      await until(async () => (await history(s)).some((m) => m.richEmbeds[0]?.title === "Other" && m.richEmbeds[0].image));
    } finally {
      limits.perBotPerHour = before;
    }
  });

  it("are copied for a card added by an edit, as for a new message", async () => {
    picturesOn();
    const s = await setup();
    const sent = await sendCards(s, { embeds: [{ title: "Plain" }] });
    await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(s.bot).send({ embeds: [{ title: "Dune", image: `${base}/poster.png` }] });
    const card = await until(async () => (await history(s))[0].richEmbeds[0]?.image);
    expect(card).toMatchObject({ width: 640, height: 480 });
    expect(hits).toEqual(["/poster.png"]);
  });

  it("are announced to other servers with the card once their copy exists", async () => {
    picturesOn();
    const s = await setup();
    const row = await prisma.community.findFirstOrThrow({ where: { protocolId: s.community.id } });
    const far = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "far", displayName: "far", homeserverDomain: "far.test", isRemote: true } });
    await prisma.communityMember.create({ data: { communityId: row.id, userId: far.id } });
    await sendCards(s, { embeds: [{ title: "Dune", image: `${base}/poster.png` }] });

    const announced = await until(async () => {
      const found = await prisma.federationOutboxEvent.findMany({ where: { domain: "far.test", path: { endsWith: "/embeds" } } });
      return found.find((e) => (e.body as { richEmbeds?: Card[] }).richEmbeds?.[0]?.image) ?? null;
    });
    const body = announced.body as { embeds: unknown[]; richEmbeds: Card[] };
    expect(body.embeds).toEqual([]);
    expect(body.richEmbeds[0]).toMatchObject({ title: "Dune", image: { width: 640, height: 480 } });
    expect(body.richEmbeds[0].image!.url.startsWith(config.baseUrl)).toBe(true);
  });

  it("do not land on the wrong card: a picture that arrives after the cards were changed is dropped", async () => {
    picturesOn();
    const s = await setup();
    const sent = await sendCards(s, { embeds: [{ title: "Old card", image: `${base}/gate.png` }] });
    await until(async () => hits.includes("/gate.png")); // the server is now waiting for it
    await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(s.bot).send({ embeds: [{ title: "New card" }] });
    openGate();
    await new Promise((r) => setTimeout(r, 500));
    const [message] = await history(s);
    expect(message.richEmbeds).toEqual([expect.objectContaining({ title: "New card" })]);
    expect(message.richEmbeds[0].image).toBeUndefined();
  });

  it("do not land on a message that was deleted while they were on their way", async () => {
    picturesOn();
    const s = await setup();
    const sent = await sendCards(s, { embeds: [{ title: "Dune", image: `${base}/gate.png` }] });
    await until(async () => hits.includes("/gate.png"));
    await api.delete(`/api/v1/messages/${sent.body.message.id}`).set(s.bot);
    openGate();
    await new Promise((r) => setTimeout(r, 400));
    expect((await stored(sent.body.message.id)).richEmbeds).toEqual([expect.objectContaining({ title: "Dune" })]);
    expect(JSON.stringify((await stored(sent.body.message.id)).richEmbeds)).not.toContain("uploads");
  });

  it("are kept while a card shows them and removed once nothing does (the cleanup reads cards as well as previews)", async () => {
    picturesOn();
    const s = await setup();
    const sent = await sendCards(s, { embeds: [{ title: "Dune", image: `${base}/poster.png`, thumbnail: `${base}/thumb.png` }] });
    await until(async () => (await history(s))[0].richEmbeds[0].thumbnail);
    expect(await prisma.linkPreviewImage.count()).toBe(2);

    // Old enough to be removed if nothing used them.
    await prisma.linkPreviewImage.updateMany({ data: { lastUsedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });
    expect(await pruneImages()).toBe(0);
    expect(await prisma.linkPreviewImage.count()).toBe(2);

    // Once the message is deleted nothing shows them.
    await api.delete(`/api/v1/messages/${sent.body.message.id}`).set(s.bot);
    expect(await pruneImages()).toBe(2);
    expect(await prisma.linkPreviewImage.count()).toBe(0);
  });

  it("are kept only while a card shows THAT one: a card that no longer names a copy lets it go", async () => {
    picturesOn();
    const s = await setup();
    const sent = await sendCards(s, { embeds: [{ title: "Dune", image: `${base}/poster.png` }] });
    await until(async () => (await history(s))[0].richEmbeds[0].image);
    await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(s.bot).send({ embeds: [{ title: "Plain" }] });
    await prisma.linkPreviewImage.updateMany({ data: { lastUsedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });
    expect(await pruneImages()).toBe(1);
  });
});

describe("cards arriving from another server", () => {
  const HOME = "alice.test";

  async function cachedCommunity() {
    const peer = await registerTestPeer(HOME);
    const owner = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "olive", displayName: "olive", homeserverDomain: HOME, isRemote: true } });
    const community = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far Club", ownerId: owner.id, homeserverDomain: HOME, isRemote: true } });
    const channel = await prisma.channel.create({ data: { protocolId: newProtocolId(), communityId: community.id, name: "general", position: 0 } });
    const me = await registerUser("reader");
    const row = await prisma.user.findFirstOrThrow({ where: { protocolId: me.user.id } });
    await prisma.communityMember.create({ data: { communityId: community.id, userId: row.id } });
    const path = `/federation/v1/communities/${community.protocolId}/channels/${channel.protocolId}`;
    const message = (extra: Record<string, unknown>) => ({
      messageId: newProtocolId(),
      fromProtocolId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      fromUsername: "robo",
      fromDomain: HOME,
      fromIsBot: true,
      content: "stand-in",
      ...extra,
    });
    const read = async () => (await api.get(`/api/v1/channels/${channel.protocolId}/messages`).set(as(me))).body.messages as { id: string; content: string | null; richEmbeds: Card[] }[];
    return { peer, path, message, me, read, channel, row };
  }

  it("are kept and shown, and the stand-in text is dropped when it is exactly the stand-in for the cards", async () => {
    const t = await cachedCommunity();
    const res = await signedPost(t.peer, `${t.path}/messages`, t.message({ content: "Dune", richEmbeds: [{ title: "Dune", description: "A film", color: "#ABCDEF" }] }));
    expect(res.status).toBe(201);
    const [shown] = await t.read();
    expect(shown.content).toBe("");
    expect(shown.richEmbeds).toEqual([{ title: "Dune", description: "A film", url: null, color: "#abcdef", fields: [], footer: null }]);
  });

  it("keep the text when it is the bot's own words, next to the cards", async () => {
    const t = await cachedCommunity();
    await signedPost(t.peer, `${t.path}/messages`, t.message({ content: "Found it:", richEmbeds: [{ title: "Dune" }] }));
    expect((await t.read())[0]).toMatchObject({ content: "Found it:", richEmbeds: [expect.objectContaining({ title: "Dune" })] });
  });

  it("are held to the same limits and cleaned the same way, whatever the other server sends", async () => {
    const t = await cachedCommunity();
    const hostile = [
      { title: "Du‮ne", url: "javascript:alert(1)", color: "red", image: { url: "https://example.com/a.png" }, thumbnail: { url: "javascript:1", width: 10, height: 10 } },
      { description: "d".repeat(5000), fields: Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, value: "v" })) },
      "not a card",
      { title: "" },
      { title: "third" },
      { title: "fourth" },
    ];
    const arriving = t.message({ richEmbeds: hostile });
    await signedPost(t.peer, `${t.path}/messages`, arriving);
    // What is KEPT is clean, not only what is shown (cleaning again on the way out is a second line, not the first).
    const kept = (await prisma.message.findUniqueOrThrow({ where: { protocolId: arriving.messageId } })).richEmbeds;
    expect(kept).toEqual(cleanRichEmbeds(hostile));
    expect(JSON.stringify(kept)).not.toContain("javascript");
    const cards = (await t.read())[0].richEmbeds;
    expect(cards.length).toBeLessThanOrEqual(3);
    expect(cards[0]).toMatchObject({ title: "Dune", url: null, color: null });
    expect(cards[0].image).toBeUndefined();
    expect(cards[0].thumbnail).toBeUndefined();
    expect([...(cards[1].description ?? "")].length).toBeLessThanOrEqual(1500);
    expect(cards[1].fields).toHaveLength(10);
  });

  it("leave a person's empty edit of their own message to be refused here, not sent to the home server", async () => {
    const t = await cachedCommunity();
    const mine = await prisma.message.create({ data: { protocolId: newProtocolId(), channelId: t.channel.id, senderId: t.row.id, content: "mine" } });
    const res = await api.patch(`/api/v1/messages/${mine.protocolId}`).set(as(t.me)).send({ content: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("ignore cards that are not a list, and a message with none is an ordinary message", async () => {
    const t = await cachedCommunity();
    await signedPost(t.peer, `${t.path}/messages`, t.message({ content: "plain", richEmbeds: "nonsense" }));
    expect((await t.read())[0]).toMatchObject({ content: "plain", richEmbeds: [] });
    // A long list is read only as far as the limit, and one made of nothing useful is no cards.
    expect((await signedPost(t.peer, `${t.path}/messages`, t.message({ content: "plain 2", richEmbeds: Array.from({ length: 60 }, () => ({})) }))).status).toBe(201);
    expect((await t.read())[1]).toMatchObject({ content: "plain 2", richEmbeds: [] });
  });

  it("are replaced by an edit that carries cards, left alone by one that does not, and removed by an empty list", async () => {
    const t = await cachedCommunity();
    const message = t.message({ content: "Found it:", richEmbeds: [{ title: "Dune" }] });
    await signedPost(t.peer, `${t.path}/messages`, message);
    const edit = (body: Record<string, unknown>) => signedPost(t.peer, `${t.path}/messages/${message.messageId}/edit`, body);

    expect((await edit({ content: "Found it:", richEmbeds: [{ title: "Part Two" }] })).status).toBe(204);
    expect((await t.read())[0].richEmbeds[0].title).toBe("Part Two");
    expect((await edit({ content: "edited text" })).status).toBe(204);
    expect((await t.read())[0]).toMatchObject({ content: "edited text", richEmbeds: [expect.objectContaining({ title: "Part Two" })] });
    expect((await edit({ content: "Part Two", richEmbeds: [{ title: "Part Two" }] })).status).toBe(204);
    expect((await t.read())[0].content).toBe(""); // the stand-in again
    expect((await edit({ content: "back", richEmbeds: [] })).status).toBe(204);
    expect((await t.read())[0]).toMatchObject({ content: "back", richEmbeds: [] });
  });

  it("are updated by the follow-up announcement (a picture's copy arriving), even on a server with link previews off", async () => {
    const t = await cachedCommunity();
    config.linkPreviewsEnabled = false;
    const message = t.message({ richEmbeds: [{ title: "Dune" }] });
    await signedPost(t.peer, `${t.path}/messages`, message);
    const copy = { url: "https://alice.test/uploads/p.png", width: 640, height: 480 };

    const res = await signedPost(t.peer, `${t.path}/messages/${message.messageId}/embeds`, { embeds: [{ url: "https://example.com", title: "ignored: previews are off" }], richEmbeds: [{ title: "Dune", image: copy }] });
    expect(res.status).toBe(204);
    config.linkPreviewImagesEnabled = true;
    config.linkPreviewsEnabled = true;
    const [shown] = await t.read();
    expect(shown.richEmbeds[0]).toMatchObject({ title: "Dune", image: copy });
    // Previews were off when it arrived, so they were not kept.
    expect((await prisma.message.findUniqueOrThrow({ where: { protocolId: message.messageId } })).embeds).toBeNull();
  });

  it("keep what a follow-up announcement says clean, and show its pictures only while pictures are on", async () => {
    const t = await cachedCommunity();
    const message = t.message({ richEmbeds: [{ title: "Dune" }] });
    await signedPost(t.peer, `${t.path}/messages`, message);
    const copy = { url: "https://alice.test/uploads/p.png", width: 640, height: 480 };
    const dirty = [{ title: "Du\u202ene", url: "javascript:alert(1)", image: copy }, "junk", { title: "" }];

    config.linkPreviewImagesEnabled = false;
    const res = await signedPost(t.peer, `${t.path}/messages/${message.messageId}/embeds`, { embeds: [], richEmbeds: dirty });
    expect(res.status).toBe(204);
    const kept = (await prisma.message.findUniqueOrThrow({ where: { protocolId: message.messageId } })).richEmbeds;
    expect(kept).toEqual(cleanRichEmbeds(dirty));
    expect(JSON.stringify(kept)).not.toContain("javascript");

    // The live event to this server's people leaves the picture out while pictures are off; it is kept for when they are on.
    const live = await events(t.me, "message:embeds");
    const payload = live[live.length - 1].payload as { richEmbeds: Card[] };
    expect(payload.richEmbeds).toHaveLength(1);
    expect(payload.richEmbeds[0].title).toBe("Dune");
    expect(payload.richEmbeds[0].image).toBeUndefined();
    expect((kept as unknown as Card[])[0].image).toEqual(copy);
  });

  it("show their pictures only while this server has pictures on", async () => {
    const t = await cachedCommunity();
    const copy = { url: "https://alice.test/uploads/p.png", width: 640, height: 480 };
    await signedPost(t.peer, `${t.path}/messages`, t.message({ richEmbeds: [{ title: "Dune", image: copy }] }));
    config.linkPreviewImagesEnabled = false;
    expect((await t.read())[0].richEmbeds[0].image).toBeUndefined();
    config.linkPreviewsEnabled = true;
    config.linkPreviewImagesEnabled = true;
    expect((await t.read())[0].richEmbeds[0].image).toEqual(copy);
  });

  it("are accepted only from the community's own server, for the community's own messages", async () => {
    const t = await cachedCommunity();
    const message = t.message({ richEmbeds: [{ title: "Dune" }] });
    await signedPost(t.peer, `${t.path}/messages`, message);
    const stranger = await registerTestPeer("mallory.test");
    const res = await signedPost(stranger, `${t.path}/messages/${message.messageId}/embeds`, { embeds: [], richEmbeds: [{ title: "Forged" }] });
    expect(res.status).toBe(403);
    expect((await t.read())[0].richEmbeds[0].title).toBe("Dune");
  });
});

describe("reports", () => {
  it("say what the cards said, so a report about a card-only message is not blank", async () => {
    const s = await setup();
    const sent = await sendCards(s, { embeds: [{ title: "Free money", description: "Click here", fields: [{ name: "Link", value: "example.com" }] }] });
    const filed = await api.post("/api/v1/reports").set(as(s.reader)).send({ kind: "message", id: sent.body.message.id, reason: "spam" });
    expect(filed.status).toBe(201);
    const report = await prisma.report.findFirstOrThrow();
    const snapshot = report.snapshot as { text: string };
    expect(snapshot.text).toContain("Free money");
    expect(snapshot.text).toContain("Click here");
    expect(snapshot.text).toContain("Link: example.com");
  });
});
