import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { PASSWORD, closeAll, createCommunity, signUp } from "../support/app";

// Download of your own data (#60), in a real browser against a real server: the password is asked for again, and the file that is
// saved has what you wrote and none of what you should not be able to get this way.

test("Settings -> Your data saves a file with what you wrote, after asking for your password again", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  try {
    const { page } = owner;
    await createCommunity(page, "Export Club");
    await page.getByPlaceholder(/Message #general/).fill("a message to keep");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".message-row").filter({ hasText: "a message to keep" })).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    const section = page.getByRole("heading", { name: "Your data" });
    await expect(section).toBeVisible();

    // A wrong password gets nothing.
    await page.getByLabel("Your password").fill("Not-The-Password-1!");
    await page.getByRole("button", { name: "Download my data" }).click();
    await expect(page.getByText("That is not your password.")).toBeVisible();

    // The right one saves the file.
    await page.getByLabel("Your password").fill(PASSWORD);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download my data" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^chat-export-olive_?[a-z0-9_]*-\d{4}-\d{2}-\d{2}\.json$/);
    const text = await readFile((await download.path())!, "utf8");
    const data = JSON.parse(text);
    expect(data.format).toBe("federated-chat-export");
    expect(data.account.username).toBe(owner.username);
    expect(data.messages.map((m: { content: string }) => m.content)).toEqual(["a message to keep"]);
    expect(data.communities.map((c: { name: string }) => c.name)).toEqual(["Export Club"]);
    expect(text).not.toMatch(/passwordHash|totpSecret|tokenHash/);
    await expect(page.getByRole("status").filter({ hasText: "Saved chat-export-" })).toBeVisible();
    await expect(page.getByLabel("Your password")).toHaveValue("");
  } finally {
    await closeAll([owner]);
  }
});
