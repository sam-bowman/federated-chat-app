import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, clientUrl, closeAll, signUp, type Person } from "../support/app";
import { enableTwoFactor, operator, totp } from "../support/operator";
import { SIDES } from "../support/stack.mjs";

// The users section of the admin page (#206), in real browsers: an admin confirms it is them (sudo mode) and then manages accounts. What matters
// is that it asks, that what it does really happens to the person, and what it refuses.
//
// One admin and one story, in steps, rather than a test each: making an admin runs the operator's command (a whole Node and Prisma start-up)
// and every test is a pair of browsers, and the servers here are shared by every spec running at once, so five of these made the others flaky.

async function openAccount(page: Page, person: Person) {
  await page.getByLabel("Find an account").fill(person.username);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: new RegExp(`@${person.username}:`) }).click();
  await expect(page.getByRole("region", { name: new RegExp(`Account @${person.username}:`) })).toBeVisible();
}

/** Answers sudo mode's question, in its dialog. */
async function confirmItsMe(page: Page, secret: string) {
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Your password").fill(PASSWORD);
  await dialog.getByLabel(/Code from your authenticator app/).fill(totp(secret));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toHaveCount(0);
}

const login = (person: Person, password = PASSWORD) =>
  person.page.request.post(`http://localhost:${SIDES.a.serverPort}/api/v1/auth/login`, { data: { username: person.username, password } });

test("an admin confirms it is them, then manages accounts: suspend, a new password, demoting, erasing", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await signUp(browser, "a", "boss");
  const tina = await signUp(browser, "a", "tina");
  const uma = await signUp(browser, "a", "uma");
  try {
    const { page } = admin;
    expect(operator("users", "make-admin", admin.username).code).toBe(0);
    const secret = await enableTwoFactor(admin);
    await page.goto(`${clientUrl("a")}/admin`);
    // The page opens on the overview; the accounts are the next tab.
    await page.getByRole("tab", { name: "Users" }).click();
    await expect(page.getByLabel("Find an account")).toBeVisible();

    await test.step("it does not change anything until the admin has said it is them, and a wrong password does not count", async () => {
      await openAccount(page, tina);
      await expect(page.getByRole("region", { name: /Account/ })).toContainText("Active");
      await page.getByRole("button", { name: "Suspend…" }).click();
      await page.getByRole("dialog", { name: /Suspend/ }).getByRole("button", { name: "Suspend", exact: true }).click();
      const sudo = page.getByRole("dialog", { name: "Confirm it is you" });
      await sudo.getByLabel("Your password").fill("Not-The-Password-1!");
      await sudo.getByLabel(/Code from your authenticator app/).fill(totp(secret));
      await sudo.getByRole("button", { name: "Confirm" }).click();
      await expect(sudo.getByText("That is not your password.")).toBeVisible();
      expect((await login(tina)).status()).toBe(200);
    });

    await test.step("backing out of confirming does nothing, and says nothing", async () => {
      await sudo_cancel(page);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator(".error-text")).toHaveCount(0);
      expect((await login(tina)).status()).toBe(200);
    });

    await test.step("confirming suspends the account for real, and lifting it does not ask again", async () => {
      await page.getByRole("button", { name: "Suspend…" }).click();
      await page.getByRole("dialog", { name: /Suspend/ }).getByRole("button", { name: "Suspend", exact: true }).click();
      await confirmItsMe(page, secret);
      await expect(page.getByRole("region", { name: /Account/ })).toContainText("Suspended since");
      expect((await login(tina)).status()).toBe(403);

      await page.getByRole("button", { name: "Unsuspend" }).click();
      await expect(page.getByRole("region", { name: /Account/ })).toContainText("Active");
      expect((await login(tina)).status()).toBe(200);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    await test.step("a new password signs the person out and is the only one that works", async () => {
      await page.getByRole("button", { name: "Set a new password…" }).click();
      const dialog = page.getByRole("dialog", { name: /New password/ });
      await dialog.getByLabel("New password").fill("Brand-New-Passw0rd!");
      await dialog.getByLabel("Again").fill("Brand-New-Passw0rd!");
      // Suspending already ended every session, so "0 that can be refreshed" is on screen before this happens: wait for the request itself.
      const reset = page.waitForResponse((r) => r.url().endsWith(`/users/${tina.username}/reset-password`) && r.request().method() === "POST");
      await dialog.getByRole("button", { name: "Set the password" }).click();
      expect((await reset).status()).toBe(200);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect((await login(tina)).status()).toBe(401);
      expect((await login(tina, "Brand-New-Passw0rd!")).status()).toBe(200);
    });

    await test.step("an admin account can only be demoted from the page, and taking admin away is at once", async () => {
      await page.getByRole("button", { name: "Make admin…" }).click();
      await page.getByRole("dialog", { name: /Make/ }).getByRole("button", { name: "Make admin", exact: true }).click();
      const account = page.getByRole("region", { name: /Account/ });
      await expect(account).toContainText("AdminYes");
      // Now she is one, so the page offers nothing but taking it away, and says why.
      await expect(page.getByRole("button", { name: "Remove admin" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Suspend…" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Delete…" })).toHaveCount(0);
      await expect(account).toContainText("only be changed here by taking admin away");

      await page.getByRole("button", { name: "Remove admin" }).click();
      await page.getByRole("dialog", { name: /Remove admin/ }).getByRole("button", { name: "Remove admin", exact: true }).click();
      await expect(account).toContainText("AdminNo");
      await expect(page.getByRole("button", { name: "Suspend…" })).toBeVisible();
    });

    await test.step("erasing at once needs the username typed out, and then the account is gone", async () => {
      await openAccount(page, uma);
      await page.getByRole("button", { name: "Delete…" }).click();
      const dialog = page.getByRole("dialog", { name: /Delete/ });
      await dialog.getByRole("radio", { name: /Erase now/ }).check();
      const erase = dialog.getByRole("button", { name: "Erase now" });
      await expect(erase).toBeDisabled();
      await dialog.getByLabel(/Type their username/).fill(uma.username.slice(0, -1));
      await expect(erase).toBeDisabled();
      await dialog.getByLabel(/Type their username/).fill(uma.username);
      await erase.click();

      await expect(page.getByRole("region", { name: /Account/ })).toHaveCount(0);
      await expect(page.getByText("Choose an account")).toBeVisible();
      expect((await login(uma)).status()).toBe(401);
      await page.getByLabel("Find an account").fill(uma.username);
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page.getByText("No accounts match.")).toBeVisible();
    });

    await test.step("all of it is in the audit log, as the admin's, from the page", async () => {
      await page.getByRole("tab", { name: "Audit log" }).click();
      await page.getByLabel("Done").selectOption("admin");
      for (const sentence of [`\\bsuspended @${tina.username}:`, `unsuspended @${tina.username}:`, `reset the password of @${tina.username}:`, `made @${tina.username}:\\S* an admin`, `took admin away from @${tina.username}:`]) {
        await expect(page.getByRole("listitem").filter({ hasText: new RegExp(sentence) }), sentence).toContainText("on the admin page");
      }
      await expect(page.getByRole("listitem").filter({ hasText: `${admin.identity} erased the account Deleted user` })).toBeVisible();
    });
  } finally {
    await closeAll([admin, tina, uma]);
  }
});

/** Backs out of the question sudo mode is asking. */
async function sudo_cancel(page: Page) {
  await page.getByRole("dialog", { name: "Confirm it is you" }).getByRole("button", { name: "Cancel" }).click();
}
