import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { SIDES } from "../support/stack.mjs";
import { accessTokenOf, closeAll, createCommunity, domainOf, joinCommunity, messageWith, openCommunity, send, signUp, uniqueName } from "../support/app";

// A bot's cards (#132, phase 3a), end to end: the repository's example bot answers `!card` with a card that is drawn on both servers (and,
// being only a card, has no text line of its own); a card's picture is fetched ONCE by the bot's own server, drawn from its copy on both, and
// never from the bot author's site; an edit changes the card live on both; and a person can hide the pictures on this device.

const EXAMPLE = fileURLToPath(new URL("../../examples/echo-bot/bot.mjs", import.meta.url));
const api = `http://localhost:${SIDES.a.serverPort}/api/v1`;
// A real 1x1 PNG, so a browser can really draw it.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function startBot(token: string): { process: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, [EXAMPLE], {
    env: { ...process.env, CHAT_URL: `http://localhost:${SIDES.a.serverPort}`, BOT_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let printed = "";
  child.stdout?.on("data", (chunk) => (printed += chunk));
  child.stderr?.on("data", (chunk) => (printed += chunk));
  return { process: child, output: () => printed };
}

/** The bot author's own web site, which only the sender's server may ever visit. Every request is recorded. */
async function serve(files: Record<string, Buffer>) {
  const visits: { path: string; userAgent: string }[] = [];
  const server: Server = createServer((req, res) => {
    visits.push({ path: req.url ?? "", userAgent: String(req.headers["user-agent"] ?? "") });
    const body = files[req.url ?? ""];
    if (!body) return void res.writeHead(404).end("no");
    res.writeHead(200, { "Content-Type": "image/png" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, visits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the example bot's card is drawn on both servers, and being only a card it has no text of its own", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await signUp(browser, "a", "olive");
  const guest = await signUp(browser, "b", "gus");
  const communityName = uniqueName("Cards Club").replace(/_/g, " ");
  const botName = `bot_${randomBytes(3).toString("hex")}`;
  let bot = null as ReturnType<typeof startBot> | null;
  try {
    const communityId = await createCommunity(owner.page, communityName);
    const mine = { Authorization: `Bearer ${await accessTokenOf(owner.page)}` };
    const made = await owner.page.request.post(`${api}/bots`, { headers: mine, data: { username: botName } });
    expect(made.status()).toBe(201);
    const { token } = await made.json();
    expect((await owner.page.request.post(`${api}/communities/${communityId}/bots`, { headers: mine, data: { username: botName } })).status()).toBe(201);
    await joinCommunity(guest.page, communityName, `${communityId}:${domainOf("a")}`);
    await openCommunity(guest.page, communityName);

    bot = startBot(token);
    await expect.poll(() => bot!.output(), { timeout: 30_000 }).toContain("Connected: listening for messages.");
    await send(owner.page, "Message #general", "!card Dune");

    for (const person of [owner, guest]) {
      const card = person.page.getByRole("article", { name: "Card: Dune" });
      await expect(card).toBeVisible();
      await expect(card).toContainText("A card from the example bot.");
      await expect(card).toContainText("Sent by");
      await expect(card).toContainText("examples/echo-bot");
      // The message is the card and nothing else: its stand-in text is not drawn beside it, and it is marked as a bot's.
      const row = person.page.locator(".message-row").filter({ has: card });
      await expect(row.locator(".message-text")).toHaveCount(0);
      await expect(row).toContainText("Bot");
    }
  } finally {
    bot?.process.kill();
    await closeAll([owner, guest]);
  }
});

test("a card's picture is copied once by the bot's server, drawn on both servers from the copy, changed live by an edit, and hidden on a device that chooses", async ({ browser }) => {
  test.setTimeout(150_000);
  const stamp = uniqueName("card");
  const site = await serve({ [`/${stamp}.png`]: PNG, [`/${stamp}-thumb.png`]: PNG });
  const owner = await signUp(browser, "a", "olive");
  const guest = await signUp(browser, "b", "gus");
  const communityName = uniqueName("Picture Cards").replace(/_/g, " ");
  const botName = `bot_${randomBytes(3).toString("hex")}`;
  try {
    const communityId = await createCommunity(owner.page, communityName);
    const mine = { Authorization: `Bearer ${await accessTokenOf(owner.page)}` };
    const made = await owner.page.request.post(`${api}/bots`, { headers: mine, data: { username: botName } });
    const { token } = await made.json();
    await owner.page.request.post(`${api}/communities/${communityId}/bots`, { headers: mine, data: { username: botName } });
    await joinCommunity(guest.page, communityName, `${communityId}:${domainOf("a")}`);
    await openCommunity(guest.page, communityName);
    const bot = { Authorization: `Bot ${token}` };
    const channelId = (await (await owner.page.request.get(`${api}/communities/${communityId}`, { headers: mine })).json()).community.channels[0].id;

    const sent = await owner.page.request.post(`${api}/channels/${channelId}/messages`, {
      headers: bot,
      data: {
        content: "Found it:",
        embeds: [{ title: "Dune", url: "https://example.com/dune", color: "#5865f2", description: "A film", image: `${site.origin}/${stamp}.png`, thumbnail: `${site.origin}/${stamp}-thumb.png` }],
      },
    });
    expect(sent.status()).toBe(201);
    const messageId = (await sent.json()).message.id as string;

    const sources: string[] = [];
    for (const person of [owner, guest]) {
      const card = person.page.getByRole("article", { name: "Card: Dune" });
      await expect(card).toBeVisible();
      const pictures = card.locator("img");
      await expect(pictures).toHaveCount(2); // they arrive after the card, announced again
      for (const index of [0, 1]) {
        await expect.poll(() => pictures.nth(index).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
        sources.push((await pictures.nth(index).getAttribute("src")) ?? "");
      }
      // The title is a link to the bot's own address, opened safely.
      const link = card.getByRole("link", { name: "Dune" });
      await expect(link).toHaveAttribute("href", "https://example.com/dune");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    }
    // Both browsers were given copies on the bot's server, and never the bot author's own files.
    expect(sources[0]).toBe(sources[2]);
    expect(sources[1]).toBe(sources[3]);
    for (const src of sources) {
      expect(src).toMatch(/\/uploads\/[^/]+\.png$/);
      expect(src).not.toContain(site.origin);
    }
    // The site was visited by the bot's own server only: each picture once, nobody else.
    expect(site.visits.map((v) => v.path).sort()).toEqual([`/${stamp}-thumb.png`, `/${stamp}.png`].sort());
    for (const visit of site.visits) expect(visit.userAgent).toMatch(/^FederatedChatLinkPreview\//);

    // An edit changes the card on both screens at once, and takes the pictures away with the old card.
    const edited = await owner.page.request.patch(`${api}/messages/${messageId}`, { headers: bot, data: { embeds: [{ title: "Dune: Part Two", description: "The sequel" }] } });
    expect(edited.status()).toBe(200);
    for (const person of [owner, guest]) {
      await expect(person.page.getByRole("article", { name: "Card: Dune: Part Two" })).toBeVisible();
      await expect(person.page.getByRole("article", { name: "Card: Dune", exact: true })).toHaveCount(0);
      await expect(person.page.getByRole("article").locator("img")).toHaveCount(0);
    }

    // Cards taken off leave the text.
    await owner.page.request.patch(`${api}/messages/${messageId}`, { headers: bot, data: { embeds: [] } });
    for (const person of [owner, guest]) {
      await expect(person.page.getByRole("article")).toHaveCount(0);
      await expect(messageWith(person.page, "Found it:")).toBeVisible();
    }

    // A person can hide the pictures on this device: a card with a picture keeps its words and loses the picture.
    await owner.page.request.patch(`${api}/messages/${messageId}`, { headers: bot, data: { embeds: [{ title: "Pictured", image: `${site.origin}/${stamp}.png` }] } });
    await expect(guest.page.getByRole("article", { name: "Card: Pictured" }).locator("img")).toHaveCount(1);
    await guest.page.getByRole("button", { name: "Settings" }).first().click();
    await guest.page.getByRole("checkbox", { name: /Show the pictures on link previews/ }).uncheck();
    await guest.page.getByRole("link", { name: /Friends & DMs/ }).click();
    await openCommunity(guest.page, communityName);
    await expect(guest.page.getByRole("article", { name: "Card: Pictured" })).toBeVisible();
    await expect(guest.page.getByRole("article", { name: "Card: Pictured" }).locator("img")).toHaveCount(0);
    await expect(owner.page.getByRole("article", { name: "Card: Pictured" }).locator("img")).toHaveCount(1); // the owner's screen is unaffected
  } finally {
    await closeAll([owner, guest]);
    await site.close();
  }
});
