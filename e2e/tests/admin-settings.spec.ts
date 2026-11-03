import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, clientUrl, closeAll, signUp } from "../support/app";
import { enableTwoFactor, operator, totp } from "../support/operator";

// The Settings tab of the admin page (#206, phase 4), in a real browser: a setting the server's environment sets is shown and cannot be changed, a
// value the server refuses comes back in its own words and changes nothing, a change goes through sudo mode, is still there after a reload, and is
// written to the audit log; and putting it back works.
//
// The e2e servers are shared by every spec running at once, so nothing here may change what other tests see. The setting that is changed is the list
// of servers this one never talks to, given a name nobody uses. That the changes TAKE EFFECT (registration closes, federation goes private, the lists
// are read) is covered by the integration tests against the real server.

async function confirmSudo(page: Page, secret: string) {
  const sudo = page.getByRole("dialog", { name: "Confirm it is you" });
  await sudo.getByLabel("Your password").fill(PASSWORD);
  await sudo.getByLabel(/Code from your authenticator app/).fill(totp(secret));
  await sudo.getByRole("button", { name: "Confirm" }).click();
  await expect(sudo).toHaveCount(0);
}

test("an admin sees which settings the environment locks, is told in the server's words when a value is refused, changes one in sudo mode, and puts it back", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await signUp(browser, "a", "setter");
  try {
    const { page } = admin;
    expect(operator("users", "make-admin", admin.username).code).toBe(0);
    const secret = await enableTwoFactor(admin);
    await page.goto(`${clientUrl("a")}/admin`);
    await page.getByRole("tab", { name: "Settings" }).click();
    const row = (label: string) => page.getByRole("listitem").filter({ has: page.getByLabel(label, { exact: true }) });
    const blocked = row("Never talk to these servers");
    const box = page.getByLabel("Never talk to these servers", { exact: true });
    // One page load, so sudo mode is asked once (a code from the app works once, and these steps are quicker than its next one). Leaving the tab and coming back asks the server again.
    const lookAgain = async () => {
      await page.getByRole("tab", { name: "Overview" }).click();
      await page.getByRole("tab", { name: "Settings" }).click();
    };
    const nobody = `nobody-${admin.username.replace(/_/g, "-")}.example.com`;

    await test.step("what the environment sets is shown and locked, and says where to change it", async () => {
      const name = page.getByLabel("Server name", { exact: true });
      await expect(name).toBeDisabled();
      await expect(name).toHaveValue("alice.test (e2e)");
      await expect(row("Server name")).toContainText("Set by the server's environment");
      await expect(row("Server name")).toContainText("SERVER_NAME");
      await expect(row("Server name").getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "Registration", exact: true })).toBeDisabled();
    });

    await test.step("a wildcard is refused in the server's own words, after sudo mode, and nothing is stored", async () => {
      await box.fill("*.example.com");
      await blocked.getByRole("button", { name: "Save" }).click();
      await confirmSudo(page, secret);
      await expect(blocked.getByRole("alert")).toContainText("wildcards are not supported");
      await expect(box).toHaveValue("*.example.com");
      await lookAgain();
      await expect(box).toHaveValue("");
    });

    await test.step("a change goes through sudo mode, says it is saved, and is still there when looked at again", async () => {
      await expect(blocked).toContainText("Default: None");
      await box.fill(`\n ${nobody.toUpperCase()} \n`);
      await blocked.getByRole("button", { name: "Save" }).click();
      // Confirmed a moment ago on this page, so it is not asked again.
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(blocked.getByRole("status")).toHaveText("Saved.");
      await expect(blocked).toContainText("Changed here");
      // The server keeps it lower-case, one to a line.
      await expect(box).toHaveValue(nobody);
      await lookAgain();
      await expect(blocked).toContainText("Changed here");
      await expect(box).toHaveValue(nobody);
    });

    await test.step("the audit log has it as the admin's, from the page, saying how many servers and not which", async () => {
      await page.getByRole("tab", { name: "Audit log" }).click();
      await page.getByLabel("Done").selectOption("admin");
      const entry = page.getByRole("listitem").filter({ hasText: `${admin.identity} changed the setting FEDERATION_BLOCKED_DOMAINS: 0 servers → 1 server` });
      await expect(entry).toContainText("on the admin page");
      await expect(page.locator("body")).not.toContainText(nobody);
    });

    await test.step("going back to the default takes the stored value away", async () => {
      await page.getByRole("tab", { name: "Settings" }).click();
      await blocked.getByRole("button", { name: /^Back to the default/ }).click();
      // Confirmed a moment ago on this page, so it is not asked again.
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(blocked).toContainText("Default: None");
      await expect(box).toHaveValue("");
      await expect(blocked.getByRole("button", { name: /^Back to the default/ })).toHaveCount(0);
    });
  } finally {
    await closeAll([admin]);
  }
});
