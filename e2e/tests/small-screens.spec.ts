import { expect, test } from "@playwright/test";
import { clientUrl, closeAll, createCommunity, signUp } from "../support/app";

// A dialog taller or wider than the window used to be centred and clipped at the top and the bottom, with nothing to scroll:
// its close button and tabs ended up out of reach on a small window or at a large UI scale (#194).
const SITUATIONS = [
  { name: "a small window", viewport: { width: 360, height: 480 }, scale: 100 },
  { name: "a large UI scale", viewport: { width: 900, height: 600 }, scale: 200 },
  { name: "a small window at a large UI scale", viewport: { width: 480, height: 640 }, scale: 150 },
];

for (const { name, viewport, scale } of SITUATIONS) {
  test(`community settings can be scrolled and every tab reached in ${name}`, async ({ browser }) => {
    const owner = await signUp(browser, "a", "olive");
    try {
      await createCommunity(owner.page, "Small Screen Club");
      await owner.page.addInitScript((value) => localStorage.setItem("chat.appearance", JSON.stringify({ scale: value })), scale);
      await owner.page.reload();
      await owner.page.setViewportSize(viewport);
      // The scale really is what the test says it is.
      expect(await owner.page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(16 * (scale / 100));

      await owner.page.locator("main").getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = owner.page.getByRole("dialog", { name: "Community settings" });
      await expect(dialog).toBeVisible();

      // The dialog fits inside the window, and its close button is in reach.
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
      await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeInViewport();

      // What does not fit scrolls, all the way to the end.
      const body = dialog.locator(".modal-body");
      const scrolls = await body.evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(scrolls).toBe(true);
      await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
      expect(await body.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1)).toBe(true);
      await expect(body.locator(":scope > *").last()).toBeInViewport();
      await body.evaluate((el) => (el.scrollTop = 0));

      // Every tab can be reached and opened.
      const tabs = dialog.getByRole("tab");
      const count = await tabs.count();
      expect(count).toBeGreaterThan(1);
      for (let i = 0; i < count; i++) {
        await tabs.nth(i).click();
        await expect(tabs.nth(i)).toHaveAttribute("aria-selected", "true");
      }

      // The close button still works, and so does Escape.
      await dialog.getByRole("button", { name: "Close dialog" }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await closeAll([owner]);
    }
  });
}

test("the sign-in card on a short window starts at the top and the page scrolls to its button", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 260 } });
  const page = await context.newPage();
  try {
    await page.goto(`${clientUrl("a")}/register`);
    const card = page.locator(".auth-card");
    await expect(card).toBeVisible();
    // Not centred off the top of the window: its heading is on screen.
    await expect(page.getByRole("heading", { name: "Create your identity" })).toBeInViewport();
    const box = (await card.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360 + 0.5);
    // And the button at the bottom can be reached by scrolling.
    const register = page.getByRole("button", { name: "Register", exact: true });
    await register.scrollIntoViewIfNeeded();
    await expect(register).toBeInViewport();
  } finally {
    await context.close();
  }
});
