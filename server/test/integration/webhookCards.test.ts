// A webhook can post cards (#132, after phases 2 and 3a): the same cards a bot sends, checked by the same validator, written and told to everyone by the same
// function as any message, with a picture copied once by this server after the answer. What a webhook is NOT given: anything a bot is not.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { pruneImages, resetImageLimitsForTests } from "../../src/modules/linkPreview/images.js";
import { resetLimitsForTests, testHooks } from "../../src/modules/linkPreview/service.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
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

// A web server for the pictures a card names.
let server: http.Server;
let base: string;
const hits: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if ((req.url ?? "").endsWith(".png")) return void res.writeHead(200, { "Content-Type": "image/png" }).end(PICTURE);
    res.writeHead(404, { "Content-Type": "text/html" }).end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(async () => {
  await resetDb();
  hits.length = 0;
  config.linkPreviewsEnabled = false;
  config.linkPreviewImagesEnabled = false;
  testHooks.allowPrivate = true;
  resetLimitsForTests();
  resetImageLimitsForTests();
});
afterEach(async () => {
  config.linkPreviewImagesEnabled = false;
  await pruneImages();
  config.linkPreviewsEnabled = false;
  testHooks.allowPrivate = false;
});

async function until<T>(read: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

type Card = { title: string | null; description: string | null; url: string | null; color: string | null; fields: { name: string; value: string; inline: boolean }[]; footer: string | null; image?: { url: string; width: number; height: number } };

async function setup() {
  const owner = await registerUser("owner");
  const community = (await api.post("/api/v1/communities").set(as(owner)).send({ name: "Club" })).body.community as { id: string; channels: { id: string }[] };
  const channelId = community.channels[0].id;
  const made = await api.post(`/api/v1/communities/${community.id}/webhooks`).set(as(owner)).send({ name: "Deploys", channelId });
  expect(made.status).toBe(201);
  const reader = await registerUser("reader");
  await api.post(`/api/v1/communities/${community.id}/members`).set(as(reader));
  const path = new URL(made.body.url as string).pathname;
  return { owner, reader, community, channelId, path, webhookId: made.body.webhook.id as string };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const postTo = (s: Setup, body: unknown) => api.post(s.path).send(body as object);
const history = async (s: Setup) => (await api.get(`/api/v1/channels/${s.channelId}/messages`).set(as(s.reader))).body.messages as { id: string; content: string | null; richEmbeds: Card[]; sender: { isBot: boolean; displayName: string } }[];
const events = (user: Registered, type: string) => prisma.syncEvent.findMany({ where: { type, recipient: { protocolId: user.user.id } }, orderBy: { seq: "asc" } });

describe("a webhook posts cards", () => {
  it("posts a message that is only a card: no text, shown live to members and in the history, from the webhook as a bot", async () => {
    const s = await setup();
    const res = await postTo(s, { embeds: [{ title: "Deploy 42", description: "Passed in 3 minutes", url: "https://ci.example/42", color: "#2ECC71", fields: [{ name: "Branch", value: "main", inline: true }], footer: "ci" }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String) });

    const [message] = await history(s);
    expect(message.content).toBe("");
    expect(message.richEmbeds).toEqual([
      { title: "Deploy 42", description: "Passed in 3 minutes", url: "https://ci.example/42", color: "#2ecc71", fields: [{ name: "Branch", value: "main", inline: true }], footer: "ci" },
    ]);
    expect(message.sender).toMatchObject({ isBot: true, displayName: "Deploys" });
    const live = await events(s.reader, "message:created");
    expect(live).toHaveLength(1);
    expect((live[0].payload as { message: { richEmbeds: Card[] } }).message.richEmbeds[0].title).toBe("Deploy 42");
  });

  it("posts text and a card together, and an ordinary post still has no cards", async () => {
    const s = await setup();
    expect((await postTo(s, { content: "Deploy done:", embeds: [{ title: "Deploy 42" }] })).status).toBe(201);
    const plain = await postTo(s, { content: "just text" });
    expect(plain.status).toBe(201);
    const [first, second] = await history(s);
    expect(first).toMatchObject({ content: "Deploy done:", richEmbeds: [expect.objectContaining({ title: "Deploy 42" })] });
    expect(second.richEmbeds).toEqual([]);
    expect((await prisma.message.findUniqueOrThrow({ where: { protocolId: plain.body.id } })).richEmbeds).toBeNull();
  });

  it("is refused for neither text nor a card, an empty list of cards, too many, a card with nothing to show, or the wrong type, and nothing is written", async () => {
    const s = await setup();
    const cases: [string, unknown][] = [
      ["nothing", {}],
      ["an empty list", { embeds: [] }],
      ["empty text and an empty list", { content: "", embeds: [] }],
      ["four cards", { embeds: [{ title: "1" }, { title: "2" }, { title: "3" }, { title: "4" }] }],
      ["a list with something that is not a card", { embeds: [5] }],
      ["not a list", { embeds: { title: "x" } }],
      ["text of the wrong type", { content: 5, embeds: [{ title: "x" }] }],
      ["too much text", { content: "x".repeat(8001) }],
    ];
    for (const [what, body] of cases) {
      const res = await postTo(s, body);
      expect(res.status, what).toBe(400);
    }
    // A card with only a picture has nothing to show without it, and is refused the way a bot's is, with the reason.
    const decorated = await postTo(s, { embeds: [{ image: `${base}/p.png` }] });
    expect(decorated.status).toBe(400);
    expect(decorated.body.error).toBe("invalid_embeds");
    expect(await prisma.message.count()).toBe(0);
  });

  it("holds a card's parts to the limits a bot's are held to, naming the reason", async () => {
    const s = await setup();
    const refused: [string, unknown, string][] = [
      ["a title over its limit", { embeds: [{ title: "t".repeat(151) }] }, "invalid_embeds"],
      ["a description over its limit", { embeds: [{ description: "d".repeat(1501) }] }, "invalid_embeds"],
      ["a card with nothing to show", { embeds: [{ url: "https://example.com", color: "#112233" }] }, "invalid_embeds"],
      ["cards whose words together are over the limit", { embeds: [1, 2, 3].map((n) => ({ title: `Card ${n}`, description: "d".repeat(1500) })) }, "embeds_too_large"],
    ];
    for (const [what, body, error] of refused) {
      const res = await postTo(s, body);
      expect(res.status, what).toBe(400);
      expect(res.body.error, what).toBe(error);
    }
    expect(await prisma.message.count()).toBe(0);
  });

  it("cleans what it was given: control and bidi characters go, the colour is stored in lower case", async () => {
    const s = await setup();
    const res = await postTo(s, { embeds: [{ title: "Dep\u0000loy‮ 42", color: "#ABCDEF" }] });
    expect(res.status).toBe(201);
    const [message] = await history(s);
    expect(message.richEmbeds[0]).toMatchObject({ title: "Deploy 42", color: "#abcdef" });
  });

  it("costs the same 404 as before when the address is wrong, whatever the body says", async () => {
    const s = await setup();
    const res = await api.post(`${s.path.slice(0, -1)}${s.path.endsWith("A") ? "B" : "A"}`).send({ embeds: [{ title: "x" }] });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect(await prisma.message.count()).toBe(0);
  });

  it("is sent on to other servers with the cards and, for a post that is only cards, the plain-text stand-in a server that predates cards can show", async () => {
    const s = await setup();
    const row = await prisma.community.findFirstOrThrow({ where: { protocolId: s.community.id } });
    const far = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "far", displayName: "far", homeserverDomain: "far.test", isRemote: true } });
    await prisma.communityMember.create({ data: { communityId: row.id, userId: far.id } });
    await postTo(s, { embeds: [{ title: "Deploy 42", description: "Passed" }] });
    const sent = await prisma.federationOutboxEvent.findMany({ where: { domain: "far.test", path: { contains: "/messages" } } });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({
      content: "Deploy 42",
      richEmbeds: [expect.objectContaining({ title: "Deploy 42", description: "Passed" })],
      fromDisplayName: "Deploys",
      fromIsBot: true,
    });
  });

  it("says what the cards said in a report about it, so a report about a card-only post is not blank", async () => {
    const s = await setup();
    const res = await postTo(s, { embeds: [{ title: "Deploy 42", description: "Passed" }] });
    const reported = await api.post("/api/v1/reports").set(as(s.reader)).send({ kind: "message", id: res.body.id, reason: "spam" });
    expect(reported.status).toBe(201);
    const report = await prisma.report.findFirstOrThrow();
    expect(JSON.stringify(report.snapshot)).toContain("Deploy 42");
  });
});

describe("a webhook's card pictures", () => {
  const picturesOn = () => {
    config.linkPreviewsEnabled = true;
    config.linkPreviewImagesEnabled = true;
  };

  it("are copied once by this server after the answer, and readers see the copy and never the poster's address", async () => {
    picturesOn();
    const s = await setup();
    const res = await postTo(s, { embeds: [{ title: "Deploy 42", image: `${base}/chart.png` }] });
    expect(res.status).toBe(201);

    const done = await until(async () => {
      const card = (await history(s))[0].richEmbeds[0];
      return card.image ? card : null;
    });
    expect(done.image).toMatchObject({ width: 640, height: 480 });
    expect(done.image!.url.startsWith(config.baseUrl)).toBe(true);
    expect(done.image!.url).not.toContain("127.0.0.1");
    expect(hits).toEqual(["/chart.png"]);
  });

  it("are not fetched, and the card is shown without them, while the server has pictures off", async () => {
    const s = await setup();
    expect((await postTo(s, { embeds: [{ title: "Deploy 42", image: `${base}/chart.png` }] })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(hits).toEqual([]);
    expect((await history(s))[0].richEmbeds[0].image).toBeUndefined();
  });

  it("are not fetched from an address the guard refuses, and the card is still posted", async () => {
    config.linkPreviewsEnabled = true;
    config.linkPreviewImagesEnabled = true;
    testHooks.allowPrivate = false;
    const s = await setup();
    expect((await postTo(s, { embeds: [{ title: "Deploy 42", image: `${base}/chart.png` }] })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(hits).toEqual([]);
    expect((await history(s))[0].richEmbeds[0]).toMatchObject({ title: "Deploy 42" });
  });

  it("are kept while a card shows them: the cleanup reads cards posted by a webhook too", async () => {
    picturesOn();
    const s = await setup();
    await postTo(s, { embeds: [{ title: "Deploy 42", image: `${base}/chart.png` }] });
    const done = await until(async () => (await history(s))[0].richEmbeds[0].image);
    await prisma.linkPreviewImage.updateMany({ data: { lastUsedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } });
    await pruneImages();
    expect((await history(s))[0].richEmbeds[0].image?.url).toBe(done.url);
    expect(await prisma.linkPreviewImage.count()).toBe(1);
  });
});

describe("what a webhook is still not given", () => {
  it("cannot edit its cards afterwards or react: it has no token, and a person's request to change its message is refused", async () => {
    const s = await setup();
    const res = await postTo(s, { embeds: [{ title: "Deploy 42" }] });
    const edit = await api.patch(`/api/v1/messages/${res.body.id}`).set(as(s.owner)).send({ embeds: [{ title: "Edited" }] });
    expect([403, 404]).toContain(edit.status);
    expect((await history(s))[0].richEmbeds[0].title).toBe("Deploy 42");
  });
});
