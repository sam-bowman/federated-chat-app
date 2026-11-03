import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { befriend, closeAll, messageWith, openDm, send, signUp, uniqueName } from "../support/app";

// Link previews (#197), end to end: a real page served from this test, read by the real servers (which are allowed to reach this
// machine only through e2e/scripts/server-entry.mjs), and shown in real browsers on both servers.

// A name without a dot is never taken for a link, so the site is its numeric address.
const HOST = "127.0.0.1";

interface Visit {
  path: string;
  userAgent: string;
}

/** A little web site on this machine. `pages` maps a path to what it answers; every request is recorded. */
async function serve(pages: Record<string, { type: string; body: string | Buffer }>) {
  const visits: Visit[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    visits.push({ path: req.url ?? "", userAgent: String(req.headers["user-agent"] ?? "") });
    const page = pages[req.url ?? ""];
    if (!page) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("no");
      return;
    }
    res.writeHead(200, { "Content-Type": page.type }).end(page.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://${HOST}:${(server.address() as AddressInfo).port}`;
  return { origin, visits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const html = (head: string) => ({ type: "text/html; charset=utf-8", body: `<!doctype html><html><head>${head}</head><body>hi</body></html>` });

test("a link gets a text card on both servers, read once by the sender's server, and its author can take it off for everyone", async ({ browser }) => {
  const slug = `/${uniqueName("post")}`;
  const site = await serve({
    // A page's words are only ever drawn as text, whatever they look like.
    [slug]: html(`<title>ignored</title><meta property="og:title" content="Tom &amp; Jerry &lt;b&gt;bold&lt;/b&gt;"><meta property="og:description" content="Cat and mouse"><meta property="og:site_name" content="Cartoon Club">`),
  });
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await befriend(alice, bella);
    await openDm(alice, bella);
    await openDm(bella, alice);

    await send(alice.page, "Message Bella", `have you seen ${site.origin}${slug} yet`);

    for (const person of [alice, bella]) {
      const card = person.page.getByLabel(`Link preview: ${HOST}`);
      await expect(card).toHaveCount(1);
      const title = card.getByRole("link", { name: "Tom & Jerry <b>bold</b>" });
      await expect(title).toHaveAttribute("href", `${site.origin}${slug}`);
      await expect(title).toHaveAttribute("target", "_blank");
      await expect(title).toHaveAttribute("rel", /noopener/);
      await expect(card).toContainText("Cat and mouse");
      // The page called itself something; the real host is always beside it.
      await expect(card).toContainText(`Cartoon Club · ${HOST}`);
      await expect(card.locator("b, img")).toHaveCount(0);
    }

    // Read once, by alice's server, as itself. Neither browser, and not bella's server, went to the site.
    expect(site.visits).toHaveLength(1);
    expect(site.visits[0].userAgent).toMatch(/^FederatedChatLinkPreview\//);

    // Only the author is offered the button, and it takes the card off here and on the other server.
    await expect(bella.page.getByRole("button", { name: /Remove the preview/ })).toHaveCount(0);
    await alice.page.getByRole("button", { name: `Remove the preview of ${HOST}` }).click();
    await expect(alice.page.getByLabel(`Link preview: ${HOST}`)).toHaveCount(0);
    await expect(bella.page.getByLabel(`Link preview: ${HOST}`)).toHaveCount(0);
    await expect(messageWith(bella.page, "have you seen")).toHaveCount(1);

    // Editing the message does not bring it back.
    await messageWith(alice.page, "have you seen").hover();
    await alice.page.getByRole("button", { name: "Edit message" }).click();
    await alice.page.locator(".message-row input").fill(`have you seen ${site.origin}${slug} now`);
    await alice.page.getByRole("button", { name: "Save" }).click();
    await expect(messageWith(bella.page, "now")).toHaveCount(1);
    await expect(alice.page.getByLabel(`Link preview: ${HOST}`)).toHaveCount(0);
    await expect(bella.page.getByLabel(`Link preview: ${HOST}`)).toHaveCount(0);
  } finally {
    await closeAll([alice, bella]);
    await site.close();
  }
});

// A real 1x1 PNG, so a browser can really draw it.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("a page's picture is copied by the sender's server and drawn on both servers, and no browser ever goes to the linked site (#244)", async ({ browser }) => {
  const stamp = uniqueName("pic");
  const site = await serve({
    [`/${stamp}-page`]: html(`<title>With a picture</title><meta property="og:image" content="/${stamp}.png">`),
    [`/${stamp}.png`]: { type: "image/png", body: PNG },
    [`/${stamp}-direct.png`]: { type: "image/png", body: PNG },
  });
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await befriend(alice, bella);
    await openDm(alice, bella);
    await openDm(bella, alice);

    await send(alice.page, "Message Bella", `look ${site.origin}/${stamp}-page`);
    const sources: string[] = [];
    for (const person of [alice, bella]) {
      const picture = person.page.getByLabel(`Link preview: ${HOST}`).locator("img");
      await expect(picture).toHaveCount(1);
      // It really is drawn, not a broken picture.
      await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
      sources.push((await picture.getAttribute("src")) ?? "");
    }
    // Both browsers were given the same address: a copy on alice's server, and never the linked site's own file.
    expect(sources[0]).toBe(sources[1]);
    expect(sources[0]).toMatch(/\/uploads\/[^/]+\.png$/);
    expect(sources[0]).not.toContain(site.origin);

    // The site was visited by alice's server only: the page and the picture, once each, and by nobody else (no browser, no other server).
    expect(site.visits.map((v) => v.path).sort()).toEqual([`/${stamp}-page`, `/${stamp}.png`].sort());
    for (const visit of site.visits) expect(visit.userAgent).toMatch(/^FederatedChatLinkPreview\//);

    // A link that is itself a picture is shown as the picture.
    await send(alice.page, "Message Bella", `and ${site.origin}/${stamp}-direct.png`);
    for (const person of [alice, bella]) {
      await expect(person.page.getByLabel(`Link preview: ${HOST}`).locator("img")).toHaveCount(2);
    }
    for (const visit of site.visits) expect(visit.userAgent).toMatch(/^FederatedChatLinkPreview\//);

    // A person can turn pictures off on this device: the text card stays, the picture goes, and a card that was only a picture goes with it.
    await bella.page.getByRole("button", { name: "Settings" }).first().click();
    await bella.page.getByRole("checkbox", { name: /Show the pictures on link previews/ }).uncheck();
    await bella.page.getByRole("link", { name: /Friends & DMs/ }).click();
    await openDm(bella, alice);
    await expect(messageWith(bella.page, "look")).toHaveCount(1);
    await expect(bella.page.getByLabel(`Link preview: ${HOST}`).getByRole("link", { name: "With a picture" })).toHaveCount(1);
    await expect(bella.page.locator(".link-preview img")).toHaveCount(0);
    await expect(bella.page.getByLabel(`Link preview: ${HOST}`)).toHaveCount(1); // only the text card; the picture-only one is not drawn
    await expect(alice.page.locator(".link-preview img")).toHaveCount(2); // alice's screen is unaffected
  } finally {
    await closeAll([alice, bella]);
    await site.close();
  }
});

test("a page that is not a web page, and one that is missing, give no card, and the message is sent as usual", async ({ browser }) => {
  const stamp = uniqueName("x");
  const site = await serve({
    [`/${stamp}-data`]: { type: "application/json", body: '{"title":"nope"}' },
    [`/${stamp}-empty`]: html(""),
  });
  const alice = await signUp(browser, "a", "alice");
  try {
    await openFreshChat(alice, browser);
    const text = `try ${site.origin}/${stamp}-data and ${site.origin}/${stamp}-empty and ${site.origin}/${stamp}-gone`;
    await send(alice.page, "Message Bella", text);
    await expect(messageWith(alice.page, "try ")).toHaveCount(1);
    // Give the server time to read all three; each was asked for, none gave a card.
    await expect.poll(() => site.visits.length).toBe(3);
    await alice.page.waitForTimeout(500);
    await expect(alice.page.getByLabel(/Link preview/)).toHaveCount(0);
  } finally {
    await closeAll([alice]);
    await site.close();
  }
});

test("previews can be hidden on this device, and come back when shown again", async ({ browser }) => {
  const slug = `/${uniqueName("page")}`;
  const site = await serve({ [slug]: html(`<title>Hide me</title><meta name="description" content="Some words">`) });
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await befriend(alice, bella);
    await openDm(alice, bella);
    await openDm(bella, alice);
    await send(alice.page, "Message Bella", `look ${site.origin}${slug}`);
    await expect(bella.page.getByLabel(`Link preview: ${HOST}`)).toHaveCount(1);

    await bella.page.getByRole("button", { name: "Settings" }).first().click();
    const box = bella.page.getByRole("checkbox", { name: /Show link previews/ });
    await expect(box).toBeChecked();
    await box.uncheck();
    await bella.page.getByRole("link", { name: /Friends & DMs/ }).click();
    await openDm(bella, alice);
    await expect(messageWith(bella.page, "look")).toHaveCount(1);
    await expect(bella.page.getByLabel(`Link preview: ${HOST}`)).toHaveCount(0);
    // Alice's own screen is unaffected: it is a choice about this device.
    await expect(alice.page.getByLabel(`Link preview: ${HOST}`)).toHaveCount(1);

    await bella.page.getByRole("button", { name: "Settings" }).first().click();
    await bella.page.getByRole("checkbox", { name: /Show link previews/ }).check();
    await bella.page.getByRole("link", { name: /Friends & DMs/ }).click();
    await openDm(bella, alice);
    await expect(bella.page.getByLabel(`Link preview: ${HOST}`)).toHaveCount(1);
  } finally {
    await closeAll([alice, bella]);
    await site.close();
  }
});

/** Alice with a friend to write to, in the open conversation (the second person is left to be closed by the browser's end). */
async function openFreshChat(alice: Awaited<ReturnType<typeof signUp>>, browser: Parameters<typeof signUp>[0]) {
  const bella = await signUp(browser, "a", "bella");
  await befriend(alice, bella);
  await openDm(alice, bella);
  await bella.context.close();
}
