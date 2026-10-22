import { expect, test } from "@playwright/test";
import { PASSWORD, clientUrl, closeAll, createCommunity, joinCommunity, openCommunity, signUp, uniqueName } from "../support/app";
import { enableTwoFactor, operator, totp } from "../support/operator";

// The Communities tab of the admin page (#206), in real browsers: an admin finds a community, hands it to a member (who really becomes able to manage it,
// while the old owner stops being able to), is refused handing it to the person who already owns it, and then deletes it (it really leaves the members'
// rail), and the audit log has both as the admin's. One admin and one story, in steps, as the other admin specs do: making an admin runs the operator's
// command, and the servers are shared by every spec running at once.

test("an admin hands a community to a member and then deletes it, and both really happen to the people in it", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await signUp(browser, "a", "olive");
  const member = await signUp(browser, "a", "max");
  const admin = await signUp(browser, "a", "boss");
  const name = uniqueName("Admin Club").replace(/_/g, " ");
  const settingsButton = (who: { page: import("@playwright/test").Page }) => who.page.locator("main").getByRole("button", { name: "Settings", exact: true });
  try {
    const communityId = await createCommunity(owner.page, name);
    await joinCommunity(member.page, name, communityId);
    await openCommunity(member.page, name);
    await expect(settingsButton(owner)).toBeVisible(); // the owner can manage it
    await expect(settingsButton(member)).toHaveCount(0); // an ordinary member cannot

    expect(operator("users", "make-admin", admin.username).code).toBe(0);
    const secret = await enableTwoFactor(admin);
    const { page } = admin;
    await page.goto(`${clientUrl("a")}/admin`);
    await page.getByRole("tab", { name: "Communities" }).click();

    await test.step("it is found by part of its name, and shows who owns it and how big it is", async () => {
      await page.getByLabel("Find a community").fill(name.slice(0, -3));
      await page.getByRole("button", { name: "Search" }).click();
      await page.getByRole("button", { name: new RegExp(name) }).click();
      const region = page.getByRole("region", { name: `Community ${name}` });
      await expect(region).toBeVisible();
      await expect(region).toContainText(`@${owner.username}:`);
      await expect(region).toContainText("2: 2 on this server, 0 on other servers");
    });

    const region = page.getByRole("region", { name: `Community ${name}` });
    const hand = async (username: string) => {
      await region.getByRole("button", { name: "Hand to another member…" }).click();
      const dialog = page.getByRole("dialog", { name: /Hand .* to another member/ });
      await dialog.getByLabel("Username of the new owner").fill(username);
      await dialog.getByRole("button", { name: "Hand it over" }).click();
    };

    await test.step("it is handed to the member after confirming it is the admin, and then they manage it and the old owner does not", async () => {
      await hand(member.username);
      const sudo = page.getByRole("dialog", { name: "Confirm it is you" });
      await sudo.getByLabel("Your password").fill(PASSWORD);
      await sudo.getByLabel(/Code from your authenticator app/).fill(totp(secret));
      await sudo.getByRole("button", { name: "Confirm" }).click();
      await expect(sudo).toHaveCount(0);
      await expect(region).toContainText(`@${member.username}:`);

      // Told live, with no reload: the new owner gets the community's settings, and the old owner (still a member) loses them.
      await expect(settingsButton(member)).toBeVisible();
      await expect(settingsButton(owner)).toHaveCount(0);
      await expect(owner.page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name })).toBeVisible();
    });

    await test.step("handing it to the person who already owns it is refused, in words", async () => {
      await hand(member.username);
      await expect(page.getByText(/already own this community/)).toBeVisible();
      await expect(region).toContainText(`@${member.username}:`);
    });

    await test.step("deleting it needs its name typed out, and then it is gone from everyone's rail", async () => {
      await region.getByRole("button", { name: "Delete…" }).click();
      const dialog = page.getByRole("dialog", { name: `Delete ${name}` });
      const confirm = dialog.getByRole("button", { name: "Delete for good" });
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel(/Type its name/).fill(name.slice(0, -1));
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel(/Type its name/).fill(name.toUpperCase());
      await confirm.click();

      // Confirmed a moment ago, so it is not asked again; the community leaves the admin's list too.
      await expect(region).toHaveCount(0);
      await expect(page.getByText("Choose a community to see it and what you can do about it.")).toBeVisible();
      for (const who of [owner, member]) {
        await expect(who.page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name })).toHaveCount(0);
      }
      await page.getByLabel("Find a community").fill(name);
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page.getByText("No communities match.")).toBeVisible();
    });

    await test.step("the audit log has both as the admin's, from the page", async () => {
      await page.getByRole("tab", { name: "Audit log" }).click();
      await page.getByLabel("Done").selectOption("admin");
      const entries = page.getByRole("listitem");
      await expect(entries.filter({ hasText: `handed ${name} to @${member.username}:` })).toContainText("on the admin page");
      await expect(entries.filter({ hasText: `deleted the community ${name}` })).toContainText("on the admin page");
    });
  } finally {
    await closeAll([owner, member, admin]);
  }
});
