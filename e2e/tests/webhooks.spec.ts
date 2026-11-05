import { expect, test, type Page } from "@playwright/test";
import { SIDES } from "../support/stack.mjs";
import { accessTokenOf, clientUrl, closeAll, createCommunity, domainOf, joinCommunity, messageWith, openCommunity, signUp, uniqueName } from "../support/app";

// Incoming webhooks (#132, phase 2), end to end: a community's owner makes a webhook in Community settings -> Integrations and is shown its
// address once, a plain HTTP request to that address (what a build server or a script does) puts a message in the channel under the
// webhook's name with a Bot badge, replacing the address ends the old one at once, and deleting the webhook keeps what it posted. A person on
// another server sees the same message with the webhook's name and the badge, never its internal name.

const api = (side: "a" | "b") => `http://localhost:${SIDES[side].serverPort}/api/v1`;

async function openIntegrations(page: Page) {
  await page.locator("main").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Integrations" }).click();
}

test("a webhook is made, shown its address once, posts under its name with a Bot badge, and is re-keyed and deleted", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await signUp(browser, "a", "olive");
  const communityName = uniqueName("Hooks Club").replace(/_/g, " ");
  try {
    const { page } = owner;
    await createCommunity(page, communityName);
    let address = "";

    await test.step("Integrations makes a webhook and shows its address once", async () => {
      await openIntegrations(page);
      await expect(page.getByText("This community has no webhooks yet.")).toBeVisible();
      await page.getByLabel("Webhook name").fill("Deploys");
      await page.getByRole("button", { name: "Make a webhook" }).click();

      const shown = page.getByLabel("Address for Deploys", { exact: true });
      await expect(shown).toBeVisible();
      address = (await shown.textContent()) ?? "";
      expect(address).toMatch(new RegExp(`^http://localhost:${SIDES.a.serverPort}/api/v1/webhooks/[A-Za-z0-9]+/mcw_[A-Za-z0-9_-]{43}$`));
      await expect(page.getByRole("list", { name: "Webhooks" })).toContainText("Posts in #general");

      // Dismissed, it is gone for good: the list never shows it and a reload does not bring it back.
      await page.getByRole("button", { name: "I have saved it" }).click();
      await expect(page.getByLabel("Address for Deploys", { exact: true })).toHaveCount(0);
      await page.reload();
      await openIntegrations(page);
      await expect(page.getByRole("list", { name: "Webhooks" })).toBeVisible();
      await expect(page.getByText(address)).toHaveCount(0);
      await page.getByRole("button", { name: "Close" }).click();
    });

    await test.step("a plain request to the address posts in the channel, marked as a bot, under the webhook's name", async () => {
      const posted = await page.request.post(address, { data: { content: "build 42 passed" } });
      expect(posted.status()).toBe(201);
      const message = messageWith(page, "build 42 passed");
      await expect(message).toBeVisible();
      await expect(message).toContainText("Deploys");
      await expect(message).toContainText("Bot");
    });

    await test.step("a wrong address is the same 404 as a missing one, and posts nothing", async () => {
      const wrong = await page.request.post(`${address.slice(0, -2)}xx`, { data: { content: "should not appear" } });
      expect(wrong.status()).toBe(404);
      expect(await wrong.json()).toEqual({ error: "not_found" });
      await expect(messageWith(page, "should not appear")).toHaveCount(0);
    });

    await test.step("a new address ends the old one at once, and the new one posts", async () => {
      await openIntegrations(page);
      await page.getByRole("button", { name: "New address for Deploys" }).click();
      await page.getByRole("button", { name: "Make a new address" }).click();
      const fresh = page.getByLabel("Address for Deploys", { exact: true });
      await expect(fresh).toBeVisible();
      const next = (await fresh.textContent()) ?? "";
      expect(next).not.toBe(address);
      await page.getByRole("button", { name: "Close" }).click();

      expect((await page.request.post(address, { data: { content: "from the old address" } })).status()).toBe(404);
      expect((await page.request.post(next, { data: { content: "from the new address" } })).status()).toBe(201);
      await expect(messageWith(page, "from the new address")).toBeVisible();
      await expect(messageWith(page, "from the old address")).toHaveCount(0);
      address = next;
    });

    await test.step("deleting the webhook stops it and keeps what it posted", async () => {
      await openIntegrations(page);
      await page.getByRole("button", { name: "Delete Deploys" }).click();
      await page.getByRole("button", { name: "Delete webhook" }).click();
      await expect(page.getByText("This community has no webhooks yet.")).toBeVisible();
      await page.getByRole("button", { name: "Close" }).click();

      expect((await page.request.post(address, { data: { content: "after the delete" } })).status()).toBe(404);
      const kept = messageWith(page, "build 42 passed");
      await expect(kept).toBeVisible();
      await expect(kept).toContainText("Deploys");
    });
  } finally {
    await closeAll([owner]);
  }
});

test("an ordinary member has no Integrations, and a person on another server sees the webhook's name and badge", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await signUp(browser, "a", "olive");
  const guest = await signUp(browser, "b", "gus");
  const communityName = uniqueName("Far Hooks").replace(/_/g, " ");
  try {
    const communityId = await createCommunity(owner.page, communityName);
    // The webhook is made through the API (the screen is covered by the test above): what is under test is the other server.
    const mine = { Authorization: `Bearer ${await accessTokenOf(owner.page)}` };
    const channelId = (await (await owner.page.request.get(`${api("a")}/communities/${communityId}`, { headers: mine })).json()).community.channels[0].id;
    const made = await owner.page.request.post(`${api("a")}/communities/${communityId}/webhooks`, { headers: mine, data: { name: "Deploys", channelId } });
    expect(made.status()).toBe(201);
    const { url } = await made.json();

    await joinCommunity(guest.page, communityName, `${communityId}:${domainOf("a")}`);
    await openCommunity(guest.page, communityName);
    // Nothing to manage for a member who holds no permission: not even the Settings button.
    await expect(guest.page.locator("main").getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);

    expect((await owner.page.request.post(url, { data: { content: "build 43 passed" } })).status()).toBe(201);
    // The guest's own server never heard of this sender until the home server relayed its message, and it says what it is called.
    const message = messageWith(guest.page, "build 43 passed");
    await expect(message).toBeVisible();
    await expect(message).toContainText("Deploys");
    await expect(message).toContainText("Bot");
    expect(await guest.page.locator("body").textContent()).not.toContain("~webhook-");
  } finally {
    await closeAll([owner, guest]);
  }
});

test("the webhook screen is reachable on a phone-sized window", async ({ browser }) => {
  test.setTimeout(90_000);
  const owner = await signUp(browser, "a", "olive");
  try {
    const { page } = owner;
    await createCommunity(page, uniqueName("Small Hooks").replace(/_/g, " "));
    // The helpers are written for a wide window, so the window is made small only after the community exists.
    await page.setViewportSize({ width: 375, height: 812 });
    await openIntegrations(page);
    const form = page.getByLabel("Webhook name");
    await expect(form).toBeVisible();
    await expect(page.getByRole("button", { name: "Make a webhook" })).toBeVisible();
    // Nothing is cut off at the side: the dialog is no wider than the window.
    const dialog = page.getByRole("dialog").first();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375 + 1);
  } finally {
    await closeAll([owner]);
  }
});
