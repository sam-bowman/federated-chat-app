import { expect, test } from "@playwright/test";
import { clientUrl, closeAll, createCommunity, joinCommunity, openCommunity, signUp } from "../support/app";
import { enableTwoFactor, operator } from "../support/operator";
import { SIDES } from "../support/stack.mjs";

// The admin page (#206) and the audit log (#59), in real browsers: the page is invisible to everyone who is not an admin, an admin has to have
// two-factor sign-in on, and what a community's moderators do shows up in the community's own audit log and on the admin page.

const settingsButton = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Settings", exact: true }).first();

test("nobody who is not an admin can tell there is an admin page", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  try {
    const { page } = alice;
    await settingsButton(page).click();
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Server administration" })).toHaveCount(0);

    // The address is the same "not found" as any other that is not a page, and the API says nothing either.
    await page.goto(`${clientUrl("a")}/admin`);
    await expect(page.getByText("Page not found.")).toBeVisible();
    await expect(page.getByText("Server administration")).toHaveCount(0);

    const token = await page.evaluate(() => localStorage.getItem("chat.accessToken"));
    const api = `http://localhost:${SIDES.a.serverPort}/api/v1`;
    const hidden = await page.request.get(`${api}/admin/me`, { headers: { Authorization: `Bearer ${token}` } });
    const missing = await page.request.get(`${api}/admin/not-a-route`, { headers: { Authorization: `Bearer ${token}` } });
    expect(hidden.status()).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    expect((await page.request.get(`${api}/admin/audit-log`)).status()).toBe(404);
  } finally {
    await closeAll([alice]);
  }
});

test("the operator makes an admin, who has to turn on two-factor sign-in before the page opens", async ({ browser }) => {
  const root = await signUp(browser, "a", "root");
  try {
    const { page } = root;
    const made = operator("users", "make-admin", root.username);
    expect(made.code, made.out).toBe(0);
    expect(made.out).toContain("two-factor");

    // Settings now offers the way in; the page says what is missing.
    await page.reload();
    await settingsButton(page).click();
    await expect(page.getByRole("heading", { name: "Server administration" })).toBeVisible();
    await page.getByRole("link", { name: "Open the admin page" }).click();
    await expect(page.getByText("Turn on two-factor sign-in first")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Audit log" })).toHaveCount(0);

    await enableTwoFactor(root);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Audit log" })).toBeVisible();
    await expect(page.getByText("asked a question")).toHaveCount(0);

    // Taking it away ends it at once, with the same session.
    expect(operator("users", "remove-admin", root.username).code).toBe(0);
    await page.reload();
    await expect(page.getByText("Page not found.")).toBeVisible();
  } finally {
    await closeAll([root]);
  }
});

test("what a moderator does is in the community's audit log and on the admin page, and never what anyone wrote", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const member = await signUp(browser, "a", "max");
  const boss = await signUp(browser, "a", "boss");
  try {
    const communityId = await createCommunity(owner.page, "Audited Club");
    await joinCommunity(member.page, "Audited Club", communityId);
    await openCommunity(owner.page, "Audited Club");

    // The owner removes the member (Settings -> Members -> Kick).
    await owner.page.locator("main").getByRole("button", { name: "Settings", exact: true }).click();
    await owner.page.getByRole("tab", { name: "Members" }).click();
    await owner.page.getByRole("button", { name: "Kick", exact: true }).click();
    await owner.page.getByRole("dialog", { name: "Kick member" }).getByRole("button", { name: "Kick", exact: true }).click();
    await expect(owner.page.getByRole("dialog", { name: "Kick member" })).toHaveCount(0);
    // The dialog closes before the server has answered: wait for the kick to land (the community is down to its owner) before looking.
    await expect(owner.page.getByRole("tab", { name: /^Members \(1\)/ })).toBeVisible();

    // Their own log shows it, and says who did it to whom.
    await owner.page.getByRole("tab", { name: "Audit log" }).click();
    const line = owner.page.getByRole("listitem").filter({ hasText: "removed" });
    await expect(line).toContainText(`@${owner.username}:`);
    await expect(line).toContainText(`@${member.username}:`);
    await expect(line).toContainText("from Audited Club");
    await expect(line).toContainText("in the app");

    // An admin sees it on the admin page, with everything else, and can filter to it.
    expect(operator("users", "make-admin", boss.username).code).toBe(0);
    await enableTwoFactor(boss);
    await boss.page.goto(`${clientUrl("a")}/admin`);
    // The page opens on Users; the audit log is the other tab.
    await boss.page.getByRole("tab", { name: "Audit log" }).click();
    // (The servers here are shared by every test running at once, so look at kicks only: the first page of everything may be full of theirs.)
    await boss.page.getByLabel("Show").selectOption("member.kick");
    const everywhere = boss.page.getByRole("listitem").filter({ hasText: `@${member.username}:` });
    await expect(everywhere).toContainText("Audited Club");
    await boss.page.getByLabel("Show").selectOption("member.ban");
    await expect(boss.page.getByRole("listitem").filter({ hasText: `@${member.username}:` })).toHaveCount(0);
    await boss.page.getByLabel("Show").selectOption("member.kick");
    await expect(boss.page.getByRole("listitem").filter({ hasText: `@${member.username}:` })).toBeVisible();

    // The member, no longer in the community, has no way to read it.
    const token = await member.page.evaluate(() => localStorage.getItem("chat.accessToken"));
    const res = await member.page.request.get(`http://localhost:${SIDES.a.serverPort}/api/v1/communities/${communityId}/audit-log`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(403);
  } finally {
    await closeAll([owner, member, boss]);
  }
});
