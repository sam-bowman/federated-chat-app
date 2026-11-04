import { expect, test } from "@playwright/test";
import { PASSWORD, clientUrl, closeAll, signUp } from "../support/app";

// Several accounts in one browser (#49), through the real client and server: add a second account without signing out of the first, switch between
// them, and have each TAB follow its own account (the choice lives in the tab, the tokens are kept per account), signing one out leaving the other.

test("one browser can be signed in to two accounts, and each tab follows its own", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await signUp(browser, "a", "alice");
  const bob = await signUp(browser, "a", "bobby"); // in a browser of its own: only so that the account exists
  try {
    const { page } = alice;
    const identity = (who: { identity: string }) => `Copy your identity, ${who.identity}`;
    const openAccounts = async (tab: typeof page) => {
      await tab.getByRole("button", { name: "Accounts", exact: true }).click();
      return tab.getByRole("dialog", { name: "Accounts" });
    };

    // Add bob's account to alice's browser: she stays signed in, the page is then loaded afresh as him.
    await (await openAccounts(page)).getByRole("button", { name: "Add another account" }).click();
    await expect(page.getByRole("heading", { name: "Add an account" })).toBeVisible();
    await page.getByPlaceholder("username").fill(bob.username);
    await page.getByPlaceholder("password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: identity(bob) })).toBeVisible();

    // Both are listed, bob's marked as in use; switching to alice needs no password.
    const dialog = await openAccounts(page);
    await expect(dialog.getByText(alice.identity)).toBeVisible();
    await expect(dialog.getByText(bob.identity)).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Switch to ${bob.identity}` })).toHaveCount(0);
    await dialog.getByRole("button", { name: `Switch to ${alice.identity}` }).click();
    await expect(page.getByRole("button", { name: identity(alice) })).toBeVisible();

    // A new tab starts on the account used last, and then follows its own choice: switching there moves no other tab.
    const second = await page.context().newPage();
    await second.goto(clientUrl("a"));
    await expect(second.getByRole("button", { name: identity(alice) })).toBeVisible();
    await (await openAccounts(second)).getByRole("button", { name: `Switch to ${bob.identity}` }).click();
    await expect(second.getByRole("button", { name: identity(bob) })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: identity(alice) })).toBeVisible(); // alice's tab is still alice's
    await second.reload();
    await expect(second.getByRole("button", { name: identity(bob) })).toBeVisible();

    // Signing bob out in his tab carries on as alice there, and he is gone from the list; alice's tab was never touched.
    await (await openAccounts(second)).getByRole("button", { name: `Sign out ${bob.identity}` }).click();
    await expect(second.getByRole("button", { name: identity(alice) })).toBeVisible();
    const again = await openAccounts(page);
    await expect(again.getByText(alice.identity)).toBeVisible();
    await expect(again.getByText(bob.identity)).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The last account signed out leaves the sign-in page, and nothing of either is kept.
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("chat.session.") || k === "chat.accessToken"));
    expect(left).toEqual([]);
  } finally {
    await closeAll([alice, bob]);
  }
});
