import { expect, test } from "@playwright/test";
import { PASSWORD, clientUrl, closeAll, signUp } from "../support/app";
import { enableTwoFactor, operator, totp } from "../support/operator";

// The Invites tab of the admin page (#206), in a real browser: an admin makes registration codes in sudo mode, copies a link that really opens the
// register screen with the code in it, revokes one, and the audit log shows all of it without ever showing a code.
//
// The e2e servers are open (not invite-only), so a code cannot be used to register here: that a code made on the page really lets someone in,
// and a revoked one does not, is covered by the integration tests against an invite-only server. One admin and one story, in steps, as the users
// spec does: making an admin runs the operator's command, and the servers are shared by every spec running at once.

test("an admin makes registration invites, copies a link that opens the register screen with the code, revokes one, and the log never shows a code", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await signUp(browser, "a", "inviter", { permissions: ["clipboard-read", "clipboard-write"] });
  const stranger = await browser.newContext();
  try {
    const { page } = admin;
    expect(operator("users", "make-admin", admin.username).code).toBe(0);
    const secret = await enableTwoFactor(admin);
    await page.goto(`${clientUrl("a")}/admin`);
    await page.getByRole("tab", { name: "Invites" }).click();
    // Several people's tests share the server, so this one's codes are found by a note of its own.
    const note = `for ${admin.username}`;
    const mine = page.getByRole("list", { name: "Registration invites" }).getByRole("listitem").filter({ hasText: note });

    await test.step("two codes are made in sudo mode, with the limits and the note that were asked for", async () => {
      await page.getByRole("button", { name: "Make invites…" }).click();
      const dialog = page.getByRole("dialog", { name: "Make registration invites" });
      await dialog.getByLabel("Accounts each code can make").fill("2");
      await dialog.getByLabel("Days until each code ends").fill("3");
      await dialog.getByLabel(/^Note/).fill(note);
      await dialog.getByLabel("How many codes to make").fill("2");
      await dialog.getByRole("button", { name: "Make", exact: true }).click();

      // It asks it is really them first, and nothing is made until then.
      const sudo = page.getByRole("dialog", { name: "Confirm it is you" });
      await sudo.getByLabel("Your password").fill(PASSWORD);
      await sudo.getByLabel(/Code from your authenticator app/).fill(totp(secret));
      await sudo.getByRole("button", { name: "Confirm" }).click();
      await expect(sudo).toHaveCount(0);

      await expect(page.getByText("Made 2 invites.")).toBeVisible();
      await expect(mine).toHaveCount(2);
      for (const row of await mine.all()) {
        await expect(row).toContainText("0 of 2 used");
        await expect(row).toContainText("Active");
      }
    });

    const row = mine.first();
    const code = (await row.locator("code").innerText()).trim();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);

    await test.step("the link it copies opens the register screen with that code already filled in", async () => {
      await row.getByRole("button", { name: "Copy link" }).click();
      await expect(row.getByRole("button", { name: "Copied" })).toBeVisible();
      const link = await page.evaluate(() => navigator.clipboard.readText());
      expect(link).toBe(`${clientUrl("a")}/register?invite=${code}`);

      const other = await stranger.newPage();
      await other.goto(link);
      await expect(other.getByLabel("Invite code")).toHaveValue(code);
      await other.close();
    });

    await test.step("a code is revoked after asking, and then it is only in the list of the ones that are over", async () => {
      await row.getByRole("button", { name: "Revoke…" }).click();
      const confirm = page.getByRole("dialog", { name: "Revoke this invite?" });
      await expect(confirm).toContainText(`ending ${code.slice(-4)}`);
      await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
      // Confirmed a moment ago, so it is not asked again.
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(mine).toHaveCount(1);
      await expect(page.getByText(code)).toHaveCount(0);

      await page.getByLabel("Show revoked, expired and used up").check();
      await expect(mine).toHaveCount(2);
      const revoked = mine.filter({ hasText: code });
      await expect(revoked).toContainText("Revoked");
      await expect(revoked.getByRole("button")).toHaveCount(0);
    });

    await test.step("the audit log has both as the admin's, from the page, naming the end of the code and never the code", async () => {
      await page.getByRole("tab", { name: "Audit log" }).click();
      await page.getByLabel("Done").selectOption("admin");
      const ending = `…${code.slice(-4)}`;
      const entries = page.getByRole("listitem");
      await expect(entries.filter({ hasText: `made a registration invite (${ending})` })).toContainText("on the admin page");
      await expect(entries.filter({ hasText: `revoked a registration invite (${ending})` })).toContainText("on the admin page");
      await expect(page.getByText(code)).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(code);
    });
  } finally {
    await stranger.close();
    await closeAll([admin]);
  }
});
