import { expect, test } from "@playwright/test";
import { closeAll, createCommunity, joinCommunity, messageWith, send, signUp, uniqueName } from "../support/app";

// Reporting (#58), in real browsers: a member reports another member's message, a moderator reads it in the community's settings and
// closes it, and the person reported sees nothing of it at any point.

test("a member reports a message, the owner reviews it in Settings, and the person reported never sees anything", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const reported = await signUp(browser, "a", "rex");
  const reporter = await signUp(browser, "a", "robin");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await joinCommunity(reported.page, name, id);
    await joinCommunity(reporter.page, name, id);
    await send(reported.page, "Message #general", "buy cheap pills here");
    await expect(messageWith(reporter.page, "buy cheap pills here")).toHaveCount(1);

    // The reporter picks a reason and says a few words.
    const row = messageWith(reporter.page, "buy cheap pills here");
    await row.hover();
    await row.getByRole("button", { name: "Report message" }).click();
    const dialog = reporter.page.getByRole("dialog", { name: "Report a message" });
    await expect(dialog.getByText(/The person who wrote it is not told/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send report" })).toBeDisabled();
    await dialog.getByRole("radio", { name: /Spam/ }).check();
    await dialog.getByLabel(/Anything a moderator should know/).fill("posts this every day");
    await dialog.getByRole("button", { name: "Send report" }).click();
    await expect(reporter.page.getByRole("dialog", { name: "Report sent" })).toBeVisible();
    await reporter.page.getByRole("button", { name: "Done" }).click();

    // The same message cannot be reported twice, and the reporter is told so.
    await row.hover();
    await row.getByRole("button", { name: "Report message" }).click();
    await reporter.page.getByRole("radio", { name: /Spam/ }).check();
    await reporter.page.getByRole("button", { name: "Send report" }).click();
    await expect(reporter.page.getByRole("alert")).toContainText("already reported");
    await reporter.page.keyboard.press("Escape");

    // Their own message has no Report button.
    await send(reporter.page, "Message #general", "my own words");
    const own = messageWith(reporter.page, "my own words");
    await own.hover();
    await expect(own.getByRole("button", { name: "Delete message" })).toBeVisible();
    await expect(own.getByRole("button", { name: "Report message" })).toHaveCount(0);

    // The owner reads it, with who made it and the snapshot, and dismisses it.
    await owner.page.locator("main").getByRole("button", { name: "Settings", exact: true }).click();
    await owner.page.getByRole("tab", { name: "Reports" }).click();
    const card = owner.page.getByRole("listitem", { name: /Spam: report about a message/ });
    await expect(card).toContainText("buy cheap pills here");
    await expect(card).toContainText(`Reported by ${reporter.identity}`);
    await expect(card).toContainText("posts this every day");
    await expect(card).toContainText("1 report in this community");
    await card.getByRole("button", { name: "Dismiss" }).click();
    await card.getByLabel(/^Note/).fill("checked, it is a joke");
    await card.getByRole("button", { name: "Dismiss report" }).click();
    await expect(owner.page.getByText("Nothing to look at. No reports are waiting.")).toBeVisible();

    // It is still there under Dismissed, and can be reopened.
    await owner.page.getByLabel("Show").selectOption("dismissed");
    await expect(owner.page.getByRole("listitem", { name: /Spam/ })).toContainText("checked, it is a joke");
    await owner.page.getByRole("button", { name: "Reopen" }).click();
    await owner.page.getByLabel("Show").selectOption("open");
    await expect(owner.page.getByRole("listitem", { name: /Spam/ })).toContainText("buy cheap pills here");

    // The person reported has no way in, and nothing on their page says they were reported (the header's Report button is for every member).
    await expect(reported.page.locator("main").getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
    await expect(reported.page.locator("body")).not.toContainText(/reported|reports/i);
  } finally {
    await closeAll([owner, reported, reporter]);
  }
});

test("a person is reported from their profile, and a community from its header (not by its owner)", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const member = await signUp(browser, "a", "mia");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await expect(owner.page.locator("main").getByRole("button", { name: "Report", exact: true })).toHaveCount(0);
    await joinCommunity(member.page, name, id);

    await member.page.locator("main").getByRole("button", { name: "Report", exact: true }).click();
    await member.page.getByRole("radio", { name: /Illegal/ }).check();
    await member.page.getByRole("button", { name: "Send report" }).click();
    await expect(member.page.getByRole("dialog", { name: "Report sent" })).toBeVisible();
    await member.page.getByRole("button", { name: "Done" }).click();

    // The owner of the community reported does not see it among their community's reports: it goes to the server's admins.
    await send(member.page, "Message #general", "hello");
    await expect(messageWith(owner.page, "hello")).toHaveCount(1);
    await owner.page.locator("main").getByRole("button", { name: "Settings", exact: true }).click();
    await owner.page.getByRole("tab", { name: "Reports" }).click();
    await expect(owner.page.getByText("Nothing to look at. No reports are waiting.")).toBeVisible();
    await owner.page.keyboard.press("Escape");

    // Reporting a person: open their profile from a message.
    await messageWith(owner.page, "hello").getByRole("button", { name: /Mia/ }).first().click();
    await owner.page.getByRole("button", { name: "Report", exact: true }).click();
    await expect(owner.page.getByRole("dialog", { name: "Report a person" })).toBeVisible();
    await owner.page.getByRole("radio", { name: /Harassment/ }).check();
    await owner.page.getByRole("button", { name: "Send report" }).click();
    await expect(owner.page.getByRole("dialog", { name: "Report sent" })).toBeVisible();
  } finally {
    await closeAll([owner, member]);
  }
});
