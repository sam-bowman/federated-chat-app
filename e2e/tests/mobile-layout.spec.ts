import { expect, test, type Page } from "@playwright/test";
import { clientUrl, closeAll, signUp } from "../support/app";

// The phone layout (#219): below 40rem wide the app shows one pane at a time, the lists or the page, instead of three columns that
// left the page about 130px. These run in a real browser at phone sizes, since jsdom computes no layout.

const PHONE = { width: 375, height: 667 };

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const visible = (page: Page, selector: string) => page.locator(selector).first().isVisible();

test("on a phone the app shows the lists or the page, one at a time, with a way back", async ({ browser }) => {
  const person = await signUp(browser, "a", "olive");
  try {
    const { page } = person;
    await page.setViewportSize(PHONE);
    await page.goto(`${clientUrl("a")}/`);

    // The landing page is the lists: communities and chats, with no page squeezed in beside them.
    await expect(page.getByRole("navigation", { name: "Communities" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Friends$/ })).toBeVisible();
    expect(await visible(page, "main")).toBe(false);
    expect(await noSideways(page)).toBe(true);

    // Opening a page gives it the whole width, and a Back bar.
    await page.getByRole("link", { name: /Friends$/ }).click();
    await expect(page.getByRole("tab", { name: /^Friends/ })).toBeVisible();
    expect(await visible(page, ".sidebar")).toBe(false);
    expect(await visible(page, ".rail")).toBe(false);
    const main = (await page.locator("main").boundingBox())!;
    expect(main.width).toBeGreaterThanOrEqual(PHONE.width - 1);
    expect(await noSideways(page)).toBe(true);

    await page.getByRole("button", { name: "‹ Chats" }).click();
    await expect(page.getByRole("link", { name: /Friends$/ })).toBeVisible();
    expect(await visible(page, "main")).toBe(false);

    // Settings, from the account footer, is a page too.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator("main").getByText("Profile", { exact: true })).toBeVisible();
    expect(await noSideways(page)).toBe(true);
  } finally {
    await closeAll([person]);
  }
});

test("a community on a phone: its channels first, then a channel with its own composer in reach", async ({ browser }) => {
  const person = await signUp(browser, "a", "olive");
  try {
    const { page } = person;
    await page.setViewportSize(PHONE);
    await page.goto(`${clientUrl("a")}/`);
    await page.getByRole("button", { name: "Create a community" }).click();
    await page.getByPlaceholder("Community name").fill("Phone Club");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    // Creating one takes you into its first channel, with the composer in reach.
    const composer = page.getByPlaceholder(/Message #general/);
    await expect(composer).toBeVisible();
    const box = (await composer.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height + 0.5);
    expect(await noSideways(page)).toBe(true);

    await composer.fill("hello from a phone");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".message-row").filter({ hasText: "hello from a phone" })).toBeVisible();

    // Back goes to this community's channels, not the home list, and a channel opens from there.
    await page.getByRole("button", { name: "‹ Phone Club" }).click();
    const general = page.getByRole("link", { name: /# general/ });
    await expect(general).toBeVisible();
    expect(await visible(page, "main")).toBe(false);
    await general.click();
    await expect(page.getByPlaceholder(/Message #general/)).toBeVisible();
    await page.getByRole("button", { name: "‹ Phone Club" }).click();

    // Tapping Home in the rail shows the chats, and tapping the community shows its channels, never a page.
    await page.getByRole("link", { name: "Friends & DMs" }).click();
    await expect(page.getByRole("link", { name: /Friends$/ })).toBeVisible();
    expect(await visible(page, "main")).toBe(false);
    await page.getByRole("link", { name: "Phone Club" }).click();
    await expect(page.getByRole("link", { name: /# general/ })).toBeVisible();
    expect(await visible(page, "main")).toBe(false);
  } finally {
    await closeAll([person]);
  }
});

test("on a wide window nothing changes: three columns and no Back bar", async ({ browser }) => {
  const person = await signUp(browser, "a", "olive");
  try {
    const { page } = person;
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto(`${clientUrl("a")}/friends`);
    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator(".mobile-back")).toHaveCount(0);
  } finally {
    await closeAll([person]);
  }
});

test("it follows the UI scale: a window that is wide at the normal size is a phone when the scale is large", async ({ browser }) => {
  const person = await signUp(browser, "a", "olive");
  try {
    const { page } = person;
    await page.addInitScript(() => localStorage.setItem("chat.appearance", JSON.stringify({ scale: 200 })));
    await page.setViewportSize({ width: 900, height: 700 }); // 900px is 28rem at 200%
    await page.goto(`${clientUrl("a")}/`);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-narrow", "true");
  } finally {
    await closeAll([person]);
  }
});


// Phase 2: a real touch screen (no hover, a coarse pointer), which the browser is told about with hasTouch and isMobile.
const TOUCH = { viewport: PHONE, hasTouch: true, isMobile: true } as const;

test("on a touch screen a tap shows a message's actions, since there is no hover", async ({ browser }) => {
  const person = await signUp(browser, "a", "olive", TOUCH);
  try {
    const { page } = person;
    await page.getByRole("button", { name: "Create a community" }).tap();
    await page.getByPlaceholder("Community name").fill("Touch Club");
    await page.getByRole("button", { name: "Create", exact: true }).tap();
    await page.getByPlaceholder(/Message #general/).fill("a message to tap");
    await page.getByRole("button", { name: "Send", exact: true }).tap();
    const row = page.locator(".message-row").filter({ hasText: "a message to tap" });
    await expect(row).toBeVisible();

    const actions = row.locator(".message-actions");
    await expect(actions).toBeHidden();
    await row.getByText("a message to tap").tap();
    await expect(actions).toBeVisible();
    await expect(row.getByRole("button", { name: "Edit message" })).toBeVisible();

    // They are under the message, not over it, and fit the screen.
    const message = (await row.getByText("a message to tap").boundingBox())!;
    const bar = (await actions.boundingBox())!;
    expect(bar.y).toBeGreaterThanOrEqual(message.y + message.height - 1);
    expect(bar.x + bar.width).toBeLessThanOrEqual(PHONE.width + 0.5);

    // A second tap puts them away again.
    await row.getByText("a message to tap").tap();
    await expect(actions).toBeHidden();
  } finally {
    await closeAll([person]);
  }
});

test("on a touch screen buttons and rows are big enough to hit, and a field does not make the page zoom", async ({ browser }) => {
  const person = await signUp(browser, "a", "olive", TOUCH);
  try {
    const { page } = person;
    const heights = (selector: string) =>
      page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.offsetParent).map((el) => Math.round(el.getBoundingClientRect().height)), selector);

    // The lists: every row.
    const rows = await heights(".sidebar-row");
    expect(rows.length).toBeGreaterThan(0);
    for (const height of rows) expect(height).toBeGreaterThanOrEqual(40);

    // A page: its buttons, and the text in its field.
    await page.getByRole("link", { name: /Friends$/ }).tap();
    await expect(page.getByRole("tab", { name: /^Friends/ })).toBeVisible();
    const buttons = await heights(".btn");
    expect(buttons.length).toBeGreaterThan(0);
    for (const height of buttons) expect(height).toBeGreaterThanOrEqual(40);
    const field = await page.locator("main input").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(field).toBeGreaterThanOrEqual(16);
  } finally {
    await closeAll([person]);
  }
});

test("a long community name does not squeeze the page header: the buttons go to a second row", async ({ browser }) => {
  const person = await signUp(browser, "a", "olive");
  try {
    const { page } = person;
    await page.setViewportSize(PHONE);
    await page.goto(`${clientUrl("a")}/`);
    await page.getByRole("button", { name: "Create a community" }).click();
    await page.getByPlaceholder("Community name").fill("A Community With A Rather Long Name");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const header = page.locator("main .main-header").first();
    await expect(header.getByText("A Community With A Rather Long Name")).toBeVisible();
    const title = (await header.getByText("A Community With A Rather Long Name").boundingBox())!;
    expect(title.x + title.width).toBeLessThanOrEqual(PHONE.width + 0.5);
    for (const name of [/^Invite/, "Settings"]) {
      const box = (await header.getByRole("button", { name }).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width + 0.5);
    }
    // The title can be read in full, not cut to a few letters with an ellipsis, and the buttons are on a row below it.
    const label = header.getByText("A Community With A Rather Long Name");
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const settings = (await header.getByRole("button", { name: "Settings" }).boundingBox())!;
    expect(settings.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
  } finally {
    await closeAll([person]);
  }
});
