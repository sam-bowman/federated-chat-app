// Pictures in link previews (#244), end to end against a real database, the real storage driver and a small web server on this machine: what is
// fetched and kept, what is refused whatever the other site claims, what is shown and to whom, and how the copies are removed again. The
// fetch guard normally refuses a server on this machine, so the tests turn it off (`testHooks.allowPrivate`); the guard itself is tested for the
// page fetch and the picture fetch alike in src/lib/linkPreview/fetchPage.test.ts.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { IMAGE_LIMITS } from "../../src/lib/linkPreview/imageInfo.js";
import { IMAGE_STORE_LIMITS, pruneImages, resetImageLimitsForTests, storeImage } from "../../src/modules/linkPreview/images.js";
import { previewFor, resetLimitsForTests, testHooks } from "../../src/modules/linkPreview/service.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;

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

// --- a web server to be linked to
let server: http.Server;
let base: string;
const hits: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const url = req.url ?? "/";
    const route = url.split("?")[0];
    const page = (image: string | null) =>
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(`<html><head><title>Page</title><meta property="og:description" content="About it">${image ? `<meta property="og:image" content="${image}">` : ""}</head></html>`);
    if (route === "/page") return page("/pic.png");
    if (route === "/page2") return page(`${base}/pic.png`);
    if (route === "/page-no-picture") return page(null);
    if (route === "/page-lies") return page("/lie.png");
    if (route === "/page-bitmap") return page("/bitmap.png");
    if (route === "/page-huge") return page("/huge.png");
    if (route === "/page-svg") return page("/script.svg");
    if (route === "/page-missing-picture") return page("/nothing.png");
    if (route === "/page-evil-name") return page("/evil.html");
    // A polyglot: starts like a PNG and goes on to be a web page. If the copy took its name from this address it would be served as HTML from OUR origin.
    if (route === "/evil.html") return void res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.concat([png(20, 20, 40), Buffer.from("<script>alert(document.domain)</script>")]));
    if (route === "/pic.png" || route === "/direct.png") return void res.writeHead(200, { "Content-Type": "image/png" }).end(PICTURE);
    if (route === "/lie.png") return void res.writeHead(200, { "Content-Type": "image/png" }).end("<html><script>alert(1)</script></html>");
    if (route === "/bitmap.png") return void res.writeHead(200, { "Content-Type": "image/png" }).end(png(5000, 5000));
    if (route === "/huge.png") return void res.writeHead(200, { "Content-Type": "image/png" }).end(png(10, 10, IMAGE_LIMITS.maxBytes + 10));
    if (route === "/script.svg") return void res.writeHead(200, { "Content-Type": "image/svg+xml" }).end("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    res.writeHead(404, { "Content-Type": "text/html" }).end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(async () => {
  await resetDb();
  hits.length = 0;
  config.linkPreviewsEnabled = true;
  config.linkPreviewImagesEnabled = true;
  testHooks.allowPrivate = true;
  resetLimitsForTests();
  resetImageLimitsForTests();
});
afterEach(async () => {
  // Take the files away too (they are not in the database), the way switching pictures off does.
  config.linkPreviewImagesEnabled = false;
  await pruneImages();
  config.linkPreviewsEnabled = false;
  testHooks.allowPrivate = false;
});

// --- helpers
const row = (user: Registered) => prisma.user.findUniqueOrThrow({ where: { protocolId: user.user.id } });
async function community(owner: Registered) {
  return (await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name: "Club" })).body.community as { id: string; channels: { id: string }[] };
}
const sendToChannel = (user: Registered, channelId: string, content: string) => api.post(`/api/v1/channels/${channelId}/messages`).set(authHeader(user.accessToken)).send({ content });
async function until<T>(read: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}
type Stored = { url: string; title: string | null; description: string | null; siteName: string | null; image?: { url: string; width: number; height: number } }[];
const embedsOf = async (messageId: string) => (await prisma.message.findUniqueOrThrow({ where: { protocolId: messageId } })).embeds as Stored | null;
const waitForEmbeds = (messageId: string) => until(async () => ((await embedsOf(messageId))?.length ? embedsOf(messageId) : null));
// In the order they were made: the rows come back in no promised order without it, and these tests read "the last one".
const eventsFor = async (user: Registered, type: string) => prisma.syncEvent.findMany({ where: { recipientId: (await row(user)).id, type }, orderBy: { seq: "asc" } });
const stored = () => prisma.linkPreviewImage.findMany({ orderBy: { createdAt: "asc" } });
/** Where a stored copy is on disk (these tests run with the disk driver). */
const fileOf = (storedUrl: string) => path.join(path.resolve(config.uploadsDir), path.basename(storedUrl));
const who = { userAgent: "Test/1", allowPrivate: true };

describe("a link to a page with a picture", () => {
  it("shows the picture on the card, kept as a copy on this server, with its size", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `look at ${base}/page`);

    const [embed] = await waitForEmbeds(sent.body.message.id);
    expect(embed).toMatchObject({ url: `${base}/page`, title: "Page", description: "About it" });
    expect(embed.image).toMatchObject({ width: 640, height: 480 });
    // The picture is on THIS server (an address a reader's browser may open), never the linked site's.
    expect(embed.image!.url.startsWith(config.baseUrl + "/uploads/")).toBe(true);
    expect(embed.image!.url.endsWith(".png")).toBe(true);

    const [copy] = await stored();
    expect(copy).toMatchObject({ url: embed.image!.url, sourceUrl: `${base}/pic.png`, width: 640, height: 480, bytes: PICTURE.length });
    expect(fs.readFileSync(fileOf(copy.storedUrl)).equals(PICTURE)).toBe(true);

    // It is what the message is read back as, and the copy is served as the picture it is.
    const history = await api.get(`/api/v1/channels/${club.channels[0].id}/messages`).set(authHeader(alice.accessToken));
    expect(history.body.messages[0].embeds[0].image).toEqual(embed.image);
    const served = await api.get(new URL(embed.image!.url).pathname);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("tells the members, with the picture in it", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await community(alice);
    await api.post(`/api/v1/communities/${club.id}/members`).set(authHeader(bob.accessToken));
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page`);
    await waitForEmbeds(sent.body.message.id);
    for (const person of [alice, bob]) {
      const events = await until(async () => {
        const found = await eventsFor(person, "message:embeds");
        return found.length > 0 ? found : null;
      });
      expect(events[0].payload).toMatchObject({ embeds: [expect.objectContaining({ image: expect.objectContaining({ width: 640, height: 480 }) })] });
    }
  });

  it("is a card without a picture when the page names none", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page-no-picture`);
    const [embed] = await waitForEmbeds(sent.body.message.id);
    expect("image" in embed).toBe(false);
    expect(await stored()).toHaveLength(0);
  });
});

describe("what a copy is named and served as", () => {
  it("comes from the bytes and never from the address: a picture at an address ending .html is a .png here, served as a picture", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page-evil-name`);
    const [embed] = await waitForEmbeds(sent.body.message.id);
    expect(embed.image!.url.endsWith(".png")).toBe(true);
    expect(embed.image!.url).not.toContain("html");
    const served = await api.get(new URL(embed.image!.url).pathname);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("what is not kept, whatever the other site says", () => {
  // Each of these pages names a picture that must not be kept, and each still gets its text card.
  const cases: [string, string][] = [
    ["a file that says it is a PNG and is a web page", "/page-lies"],
    ["a small file that describes a bitmap of 25 million pixels", "/page-bitmap"],
    ["a picture over the size limit in bytes", "/page-huge"],
    ["an SVG, which can carry script", "/page-svg"],
    ["an address that is not there", "/page-missing-picture"],
  ];
  for (const [what, route] of cases) {
    it(`${what}: the card has no picture and nothing is stored`, async () => {
      const alice = await registerUser("alice");
      const club = await community(alice);
      const sent = await sendToChannel(alice, club.channels[0].id, `${base}${route}`);
      const [embed] = await waitForEmbeds(sent.body.message.id);
      expect(embed.title).toBe("Page");
      expect("image" in embed).toBe(false);
      expect(await stored()).toHaveLength(0);
    });
  }
});

describe("a link that is itself a picture", () => {
  it("is shown as the picture, with the site it is on", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/direct.png`);
    const [embed] = await waitForEmbeds(sent.body.message.id);
    expect(embed).toMatchObject({ url: `${base}/direct.png`, title: null, description: null, siteName: "127.0.0.1", image: { width: 640, height: 480 } });
    expect(await stored()).toHaveLength(1);
  });

  it("is only a link when the bytes are not a picture, however the site names them", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/lie.png`);
    await new Promise((r) => setTimeout(r, 400));
    expect(await embedsOf(sent.body.message.id)).toBeNull();
    expect(await stored()).toHaveLength(0);
  });

  it("is only a link when pictures are off", async () => {
    config.linkPreviewImagesEnabled = false;
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/direct.png`);
    await new Promise((r) => setTimeout(r, 400));
    expect(await embedsOf(sent.body.message.id)).toBeNull();
    expect(await stored()).toHaveLength(0);
  });
});

describe("the switch", () => {
  it("is off until the operator turns it on: the card is text, the picture is never asked for, nothing is stored", async () => {
    config.linkPreviewImagesEnabled = false;
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page`);
    const [embed] = await waitForEmbeds(sent.body.message.id);
    expect(embed.title).toBe("Page");
    expect("image" in embed).toBe(false);
    expect(hits.filter((h) => h.includes("pic.png"))).toEqual([]);
    expect(await stored()).toHaveLength(0);
  });

  it("does nothing while link previews themselves are off, even with pictures on", async () => {
    config.linkPreviewsEnabled = false;
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page`);
    await new Promise((r) => setTimeout(r, 300));
    expect(await embedsOf(sent.body.message.id)).toBeNull();
    expect(hits).toEqual([]);
  });

  it("hides the pictures it holds when turned off (the card stays), shows them again when turned back on, and takes the files away", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page`);
    const [embed] = await waitForEmbeds(sent.body.message.id);
    const list = () => api.get(`/api/v1/channels/${club.channels[0].id}/messages`).set(authHeader(alice.accessToken));
    const [copy] = await stored();

    config.linkPreviewImagesEnabled = false;
    expect((await list()).body.messages[0].embeds).toEqual([{ url: `${base}/page`, title: "Page", description: "About it", siteName: "127.0.0.1" }]);
    expect(await pruneImages()).toBe(1);
    expect(fs.existsSync(fileOf(copy.storedUrl)), "the file is gone").toBe(false);
    expect(await stored()).toHaveLength(0);

    // Back on: the message still names a copy that is no longer there. The card shows without it rather than with a broken picture? It shows what the
    // message holds; the copy is gone, so that is what a reader would be shown.
    config.linkPreviewImagesEnabled = true;
    expect((await list()).body.messages[0].embeds[0].image).toEqual(embed.image);
  });

  it("does not tell other servers about a picture while off", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const sent = await sendToChannel(alice, club.channels[0].id, `${base}/page`);
    await waitForEmbeds(sent.body.message.id);
    config.linkPreviewImagesEnabled = false;
    const { announceEmbeds } = await import("../../src/modules/linkPreview/service.js");
    const message = await prisma.message.findUniqueOrThrow({ where: { protocolId: sent.body.message.id } });
    await prisma.syncEvent.deleteMany();
    await announceEmbeds(message.id);
    const events = await eventsFor(alice, "message:embeds");
    expect(events[0].payload).toMatchObject({ embeds: [expect.objectContaining({ title: "Page" })] });
    expect(JSON.stringify(events[0].payload)).not.toContain("/uploads/");
  });
});

describe("one copy per picture, and a page remembered", () => {
  it("fetches a picture once however many pages name it", async () => {
    await previewFor(`${base}/page`, "u1");
    await previewFor(`${base}/page2`, "u1"); // names the same picture by its absolute address
    expect(hits.filter((h) => h.includes("pic.png"))).toHaveLength(1);
    expect(await stored()).toHaveLength(1);
  });

  it("does not fetch the page or the picture again within the day, and keeps the picture on the card", async () => {
    const first = await previewFor(`${base}/page`, "u1");
    hits.length = 0;
    const second = await previewFor(`${base}/page`, "u1");
    expect(hits).toEqual([]);
    expect(second).toEqual(first);
    expect(second?.image).toBeDefined();
  });

  it("shows a remembered card without its picture if the copy has gone since", async () => {
    await previewFor(`${base}/page`, "u1");
    await prisma.linkPreviewImage.deleteMany();
    const again = await previewFor(`${base}/page`, "u1");
    expect(again?.title).toBe("Page");
    expect(again && "image" in again).toBe(false);
  });
});

describe("the limits", () => {
  it("make no new copy once the copies already made add up to the ceiling, and the card is still shown", async () => {
    await prisma.linkPreviewImage.create({ data: { url: "https://chat.test/uploads/x.png", storedUrl: "/uploads/x.png", sourceUrl: "https://x.test/x.png", width: 1, height: 1, bytes: IMAGE_STORE_LIMITS.maxTotalBytes } });
    const embed = await previewFor(`${base}/page`, "u1");
    expect(embed?.title).toBe("Page");
    expect(embed && "image" in embed).toBe(false);
    expect(hits.filter((h) => h.includes("pic.png"))).toEqual([]);
    await prisma.linkPreviewImage.deleteMany(); // not a real file: nothing for the cleanup to remove
  });

  it("fetch only so many pictures an hour, for the whole server", async () => {
    let made = 0;
    for (let i = 0; i < IMAGE_STORE_LIMITS.perServerPerHour + 5; i++) {
      if (await storeImage(`${base}/pic.png?n=${i}`, who)) made++;
    }
    expect(made).toBe(IMAGE_STORE_LIMITS.perServerPerHour);
  });

  it("do not stop a picture that was fetched already: it is reused, which costs nothing", async () => {
    await storeImage(`${base}/pic.png`, who);
    for (let i = 0; i < 20; i++) expect(await storeImage(`${base}/pic.png`, who)).not.toBeNull();
    expect(hits.filter((h) => h.includes("pic.png"))).toHaveLength(1);
  });
});

describe("removing the copies nothing shows any more", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const old = () => new Date(Date.now() - IMAGE_STORE_LIMITS.graceMs - DAY);

  async function messageWithPicture(alice: Registered, club: { channels: { id: string }[] }, text: string) {
    const sent = await sendToChannel(alice, club.channels[0].id, text);
    await waitForEmbeds(sent.body.message.id);
    const copy = (await stored()).at(-1)!;
    await prisma.linkPreviewImage.update({ where: { id: copy.id }, data: { lastUsedAt: old() } });
    await prisma.linkPreviewCache.deleteMany(); // a day has passed: the page is read again, and its picture is the one it names now
    return { messageId: sent.body.message.id as string, copy };
  }

  it("keeps a copy a message still shows, and removes one nothing shows (file and record)", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const { copy } = await messageWithPicture(alice, club, `${base}/page`);
    const orphanFile = path.join(path.resolve(config.uploadsDir), "orphan-preview.png");
    fs.writeFileSync(orphanFile, PICTURE);
    await prisma.linkPreviewImage.create({ data: { url: `${config.baseUrl}/uploads/orphan-preview.png`, storedUrl: "/uploads/orphan-preview.png", sourceUrl: "https://x.test/o.png", width: 1, height: 1, bytes: 1, lastUsedAt: old() } });

    expect(await pruneImages()).toBe(1);
    expect((await stored()).map((c) => c.id)).toEqual([copy.id]);
    expect(fs.existsSync(fileOf(copy.storedUrl))).toBe(true);
    expect(fs.existsSync(orphanFile), "the unused file is gone").toBe(false);
  });

  it("removes a copy once the message that showed it is deleted, or its preview taken off, or the link edited away", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const one = await messageWithPicture(alice, club, `${base}/page`);
    expect(await pruneImages()).toBe(0);

    await api.delete(`/api/v1/messages/${one.messageId}`).set(authHeader(alice.accessToken));
    expect(await pruneImages()).toBe(1);
    expect(fs.existsSync(fileOf(one.copy.storedUrl))).toBe(false);

    const two = await messageWithPicture(alice, club, `${base}/page`);
    await api.delete(`/api/v1/messages/${two.messageId}/embeds`).set(authHeader(alice.accessToken));
    expect(await pruneImages()).toBe(1);
  });

  it("keeps a copy for the two days a message that will show it may still be on its way, whatever shows it now", async () => {
    await storeImage(`${base}/pic.png`, who);
    expect(await pruneImages()).toBe(0);
    expect(await stored()).toHaveLength(1);
  });

  it("counts a copy that is reused as used just now, so it is not removed under the message about to show it", async () => {
    await storeImage(`${base}/pic.png`, who);
    const [copy] = await stored();
    await prisma.linkPreviewImage.update({ where: { id: copy.id }, data: { lastUsedAt: old() } });
    expect(await storeImage(`${base}/pic.png`, who)).toMatchObject({ url: copy.url }); // reused, not fetched again
    expect(hits.filter((h) => h.includes("pic.png"))).toHaveLength(1);
    expect(await pruneImages()).toBe(0);
    expect(await stored()).toHaveLength(1);
  });

  it("keeps a copy that any one of several messages still shows", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    const a = await messageWithPicture(alice, club, `${base}/page`);
    const sentB = await sendToChannel(alice, club.channels[0].id, `${base}/page2`);
    await waitForEmbeds(sentB.body.message.id);
    expect(await stored()).toHaveLength(1); // the same picture
    await api.delete(`/api/v1/messages/${a.messageId}`).set(authHeader(alice.accessToken));
    expect(await pruneImages()).toBe(0);
    await api.delete(`/api/v1/messages/${sentB.body.message.id}`).set(authHeader(alice.accessToken));
    expect(await pruneImages(), "B used it just now, so it is still within its two days").toBe(0);
    await prisma.linkPreviewImage.updateMany({ data: { lastUsedAt: old() } });
    expect(await pruneImages()).toBe(1);
  });

  it("removes every copy while pictures are off, shown or not, and old or new", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    await messageWithPicture(alice, club, `${base}/page`);
    await storeImage(`${base}/pic.png?fresh`, who);
    expect(await stored()).toHaveLength(2);
    config.linkPreviewImagesEnabled = false;
    expect(await pruneImages()).toBe(2);
    expect(await stored()).toHaveLength(0);
  });
});

describe("other servers", () => {
  async function remoteChat() {
    const alice = await registerUser("alice");
    const far = await registerTestPeer("far.test");
    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: "far.test", isRemote: true } });
    const aliceRow = await row(alice);
    const conversation = await prisma.conversation.create({ data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: aliceRow.id }, { userId: remy.id }] } } });
    const message = await prisma.message.create({ data: { protocolId: newProtocolId(), conversationId: conversation.id, senderId: remy.id, content: "from far away" } });
    return { alice, far, message, conversation };
  }
  const picture = { url: "https://far.test/uploads/abc.png", width: 800, height: 400 };

  it("are told where the sender's copy is, in the preview, and the picture is shown from there; this server fetches nothing", async () => {
    const alice = await registerUser("alice");
    const club = await community(alice);
    // A chat with someone on another server: the other server is queued to be told what the previews are.
    const far = await registerTestPeer("far.test");
    const remy = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: "far.test", isRemote: true } });
    const conversation = await prisma.conversation.create({ data: { protocolId: newProtocolId(), type: "DM", members: { create: [{ userId: (await row(alice)).id }, { userId: remy.id }] } } });
    const sent = await api.post(`/api/v1/conversations/${conversation.protocolId}/messages`).set(authHeader(alice.accessToken)).send({ content: `${base}/page` });
    await waitForEmbeds(sent.body.message.id);
    const queued = await until(async () => {
      const rows = await prisma.federationOutboxEvent.findMany({ where: { path: `/messages/${sent.body.message.id}/embeds` } });
      return rows.length > 0 ? rows : null;
    });
    expect(queued[0].body).toMatchObject({ embeds: [expect.objectContaining({ image: expect.objectContaining({ width: 640, height: 480, url: expect.stringContaining("/uploads/") }) })] });
    expect(far).toBeTruthy();
    expect(club).toBeTruthy();
  });

  it("keep what a peer says about a picture, checked, and show it while this server has pictures on", async () => {
    const { alice, far, message } = await remoteChat();
    const res = await signedPost(far, `/federation/v1/messages/${message.protocolId}/embeds`, {
      embeds: [{ url: "https://far.test/page", title: "Far page", image: { ...picture, html: "<b>" } }],
    });
    expect(res.status).toBe(204);
    expect(await embedsOf(message.protocolId)).toEqual([{ url: "https://far.test/page", title: "Far page", description: null, siteName: null, image: picture }]);
    const told = await eventsFor(alice, "message:embeds");
    expect(told[0].payload).toMatchObject({ embeds: [expect.objectContaining({ image: picture })] });
    expect(hits).toEqual([]); // nothing was fetched: neither the page nor the picture
    expect(await stored()).toHaveLength(0);
  });

  it("drop a picture reference that is not a plain address with a sane size, and keep the rest of the card", async () => {
    const { far, message } = await remoteChat();
    await signedPost(far, `/federation/v1/messages/${message.protocolId}/embeds`, {
      embeds: [
        { url: "https://far.test/a", title: "A", image: { url: "javascript:alert(1)", width: 10, height: 10 } },
        { url: "https://far.test/b", title: "B", image: { url: "https://far.test/x.png", width: 100000, height: 10 } },
        { url: "https://far.test/c", title: "C", image: { url: "/relative.png", width: 10, height: 10 } },
        { url: "https://far.test/d", image: { url: "https://far.test/x.png", width: 0, height: 0 } },
      ],
    });
    const kept = (await embedsOf(message.protocolId))!;
    expect(kept.map((e) => e.title)).toEqual(["A", "B", "C"]);
    for (const embed of kept) expect("image" in embed).toBe(false);
  });

  it("show no picture of another server's while this server has pictures off, and so never make a reader's browser ask for it", async () => {
    config.linkPreviewImagesEnabled = false;
    const { alice, far, message } = await remoteChat();
    await signedPost(far, `/federation/v1/messages/${message.protocolId}/embeds`, { embeds: [{ url: "https://far.test/page", title: "Far page", image: picture }] });
    const told = await eventsFor(alice, "message:embeds");
    expect(told[0].payload).toMatchObject({ embeds: [{ url: "https://far.test/page", title: "Far page" }] });
    expect(JSON.stringify(told[0].payload)).not.toContain("far.test/uploads");
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { messages: { some: { id: message.id } } } });
    const history = await api.get(`/api/v1/conversations/${conversation.protocolId}/messages`).set(authHeader(alice.accessToken));
    expect(JSON.stringify(history.body.messages[0].embeds)).not.toContain("far.test/uploads");
  });

  it("show a card that is only a picture as nothing at all while pictures are off", async () => {
    config.linkPreviewImagesEnabled = false;
    const { alice, far, message, conversation } = await remoteChat();
    await signedPost(far, `/federation/v1/messages/${message.protocolId}/embeds`, { embeds: [{ url: "https://far.test/p.png", image: picture }] });
    const history = await api.get(`/api/v1/conversations/${conversation.protocolId}/messages`).set(authHeader(alice.accessToken));
    expect(history.body.messages[0].embeds).toEqual([]);
  });
});
