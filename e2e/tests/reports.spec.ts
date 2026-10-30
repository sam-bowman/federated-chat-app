import { expect, test } from "@playwright/test";
import { clientUrl, closeAll, createCommunity, domainOf, joinCommunity, messageWith, send, signUp, uniqueName } from "../support/app";
import { enableTwoFactor, operator } from "../support/operator";

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

    // The owner's page was open before the report was made: coming back to it is when it asks again, and the Settings button then says
    // that a report is waiting (and the person reported, below, is told nothing like it).
    await owner.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const settings = owner.page.locator("main").getByRole("button", { name: /^Settings/ });
    await expect(settings).toHaveText("Settings · 1 report");

    // The owner reads it, with who made it and the snapshot, and dismisses it.
    await settings.click();
    await owner.page.getByRole("tab", { name: "Reports (1)" }).click();
    const card = owner.page.getByRole("listitem", { name: /Spam: report about a message/ });
    await expect(card).toContainText("buy cheap pills here");
    await expect(card).toContainText(`Reported by ${reporter.identity}`);
    await expect(card).toContainText("posts this every day");
    await expect(card).toContainText("1 report in this community");

    // The messages around it, as they are now: the reported one is marked, and what was said after it is there too.
    await card.getByRole("button", { name: "Show the messages around it" }).click();
    const around = card.getByRole("list", { name: /Messages around the reported one in # general/ });
    await expect(around.getByRole("listitem").filter({ hasText: "the reported message" })).toContainText("buy cheap pills here");
    await expect(around).toContainText("my own words");

    await card.getByRole("button", { name: "Dismiss" }).click();
    await card.getByLabel(/^Note/).fill("checked, it is a joke");
    await card.getByRole("button", { name: "Dismiss report" }).click();
    await expect(owner.page.getByText("Nothing to look at. No reports are waiting.")).toBeVisible();
    // Closing it takes the number off the tab, and off the button once the dialog is closed.
    await expect(owner.page.getByRole("tab", { name: "Reports", exact: true })).toBeVisible();
    await owner.page.keyboard.press("Escape");
    await expect(settings).toHaveText("Settings");
    await settings.click();
    await owner.page.getByRole("tab", { name: "Reports", exact: true }).click();

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

// A community on another server (#58, relaying): the member's own server carries the report to the community's home server, where the
// owner reads it. Two real servers (alice.test and bob.test) over the signed federation protocol.
test("a member on another server reports a message in a community, and its owner on the home server reads it", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const guest = await signUp(browser, "a", "gus");
  const visitor = await signUp(browser, "b", "vera");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await joinCommunity(guest.page, name, id);
    await joinCommunity(visitor.page, name, `${id}:${domainOf("a")}`);
    await expect(visitor.page.getByPlaceholder("Message #general")).toBeVisible();
    // History is not backfilled on join, so Gus speaks after Vera is in. (A report about the owner's own words would not be shown to the owner.)
    await send(guest.page, "Message #general", "words said on the home server");
    await expect(messageWith(visitor.page, "words said on the home server")).toHaveCount(1);
    await send(visitor.page, "Message #general", "hello from the other server");
    await expect(messageWith(owner.page, "hello from the other server")).toHaveCount(1);

    // Vera reports Gus's message; the dialog says it goes to the other server.
    const row = messageWith(visitor.page, "words said on the home server");
    await row.hover();
    await row.getByRole("button", { name: "Report message" }).click();
    const dialog = visitor.page.getByRole("dialog", { name: "Report a message" });
    await expect(dialog).toContainText(`It is sent to ${domainOf("a")}, where this community lives`);
    await dialog.getByRole("radio", { name: /Harassment/ }).check();
    await dialog.getByLabel(/Anything a moderator should know/).fill("seen from the other server");
    await dialog.getByRole("button", { name: "Send report" }).click();
    await expect(visitor.page.getByRole("dialog", { name: "Report sent" })).toBeVisible();
    await visitor.page.getByRole("button", { name: "Done" }).click();

    // Again: told, without a second report.
    await row.hover();
    await row.getByRole("button", { name: "Report message" }).click();
    await visitor.page.getByRole("radio", { name: /Spam/ }).check();
    await visitor.page.getByRole("button", { name: "Send report" }).click();
    await expect(visitor.page.getByRole("alert")).toContainText("already reported");
    await visitor.page.keyboard.press("Escape");

    // Vera's own server shows nothing of it to anyone: she has no Settings in a community she does not run.
    await expect(visitor.page.locator("main").getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);

    // The owner opens the community's Reports: the message as the home server has it, and Vera as a person on the other server.
    await owner.page.locator("main").getByRole("button", { name: /^Settings/ }).click();
    await owner.page.getByRole("tab", { name: "Reports" }).click();
    const card = owner.page.getByRole("listitem", { name: /Harassment: report about a message/ });
    await expect(card).toContainText("words said on the home server");
    await expect(card).toContainText(`Reported by ${visitor.identity}`);
    await expect(card).toContainText("seen from the other server");
    await expect(card).toContainText("1 report in this community");
  } finally {
    await closeAll([owner, guest, visitor]);
  }
});

// The admins' queue (#58, #296): a report reaches the admin page with a count, and unlike a community's moderators an admin is shown what was
// reported and nothing of the conversation around it.
test("an admin reads a report on the admin page, with a count, and is not offered the messages around it", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const reported = await signUp(browser, "a", "rex");
  const reporter = await signUp(browser, "a", "robin");
  const boss = await signUp(browser, "a", "boss");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await joinCommunity(reported.page, name, id);
    await joinCommunity(reporter.page, name, id);
    await send(reported.page, "Message #general", "words for the admin to read");
    await expect(messageWith(reporter.page, "words for the admin to read")).toHaveCount(1);

    const row = messageWith(reporter.page, "words for the admin to read");
    await row.hover();
    await row.getByRole("button", { name: "Report message" }).click();
    const dialog = reporter.page.getByRole("dialog", { name: "Report a message" });
    await dialog.getByRole("radio", { name: /Impersonation/ }).check();
    await dialog.getByLabel(/Anything a moderator should know/).fill("seen by the admins too");
    await dialog.getByRole("button", { name: "Send report" }).click();
    await expect(reporter.page.getByRole("dialog", { name: "Report sent" })).toBeVisible();

    // (The servers are shared by every test running at once, so the number is not looked at, only that there is one.)
    expect(operator("users", "make-admin", boss.username).code).toBe(0);
    await enableTwoFactor(boss);
    await boss.page.goto(`${clientUrl("a")}/settings`);
    await expect(boss.page.getByText(/\d+ reports? waiting/)).toBeVisible();

    await boss.page.goto(`${clientUrl("a")}/admin`);
    await expect(boss.page.getByRole("tab", { name: /^Reports \(\d+\)$/ })).toBeVisible();
    await boss.page.getByRole("tab", { name: /^Reports/ }).click();
    const card = boss.page.getByRole("listitem", { name: /Impersonation: report about a message/ });
    await expect(card).toContainText("words for the admin to read");
    await expect(card).toContainText("seen by the admins too");
    await expect(card).toContainText(`Reported by ${reporter.identity}`);
    await expect(card.getByRole("button", { name: "Show the messages around it" })).toHaveCount(0);

    await card.getByRole("button", { name: "Dismiss" }).click();
    await card.getByRole("button", { name: "Dismiss report" }).click();
    await expect(boss.page.getByRole("listitem", { name: /Impersonation: report about a message/ })).toHaveCount(0);
  } finally {
    await closeAll([owner, reported, reporter, boss]);
  }
});

// A phone is 375px wide (#219): nothing the reports added may push the page sideways or off the screen.
test("at phone width the header buttons, the Reports tab and the messages around a report fit the screen", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const member = await signUp(browser, "a", "mia");
  const reported = await signUp(browser, "a", "rex");
  try {
    const name = uniqueName("club");
    const id = await createCommunity(owner.page, name);
    await joinCommunity(member.page, name, id);
    await joinCommunity(reported.page, name, id);
    // (A report about the owner's own words would not be shown to the owner, so the one reported is a third person.)
    await send(reported.page, "Message #general", "words from the reported one");
    await expect(messageWith(member.page, "words from the reported one")).toHaveCount(1);
    await send(member.page, "Message #general", "words from the member");
    await expect(messageWith(owner.page, "words from the member")).toHaveCount(1);

    const row = messageWith(member.page, "words from the reported one");
    await row.hover();
    await row.getByRole("button", { name: "Report message" }).click();
    await member.page.getByRole("radio", { name: /Spam/ }).check();
    await member.page.getByRole("button", { name: "Send report" }).click();
    await expect(member.page.getByRole("dialog", { name: "Report sent" })).toBeVisible();
    await member.page.getByRole("button", { name: "Done" }).click();

    const PHONE = { width: 375, height: 667 };
    const noSideways = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    const insideScreen = async (locator: import("@playwright/test").Locator) => {
      const box = (await locator.boundingBox())!;
      return box.x >= 0 && box.x + box.width <= PHONE.width + 1;
    };

    // The member's header: Invite, Report and Leave.
    await member.page.setViewportSize(PHONE);
    await expect(member.page.locator("main").getByRole("button", { name: "Report", exact: true })).toBeVisible();
    expect(await noSideways(member.page)).toBe(true);
    const header = member.page.locator(".main-header");
    for (const button of [header.getByRole("button", { name: /^Invite/ }), header.getByRole("button", { name: "Report", exact: true }), header.getByRole("button", { name: "Leave", exact: true })]) {
      expect(await insideScreen(button)).toBe(true);
    }

    // The owner's: Settings with the number on it, the longest it gets with a report waiting.
    await owner.page.setViewportSize(PHONE);
    await owner.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const settings = owner.page.locator("main").getByRole("button", { name: /^Settings/ });
    await expect(settings).toHaveText("Settings · 1 report");
    expect(await noSideways(owner.page)).toBe(true);
    expect(await insideScreen(settings)).toBe(true);

    await settings.click();
    const dialog = owner.page.getByRole("dialog");
    expect(await insideScreen(dialog)).toBe(true);
    await owner.page.getByRole("tab", { name: "Reports (1)" }).click();
    const card = owner.page.getByRole("listitem", { name: /Spam: report about a message/ });
    await expect(card).toContainText("words from the reported one");
    await card.getByRole("button", { name: "Show the messages around it" }).click();
    const around = card.getByRole("list", { name: /Messages around the reported one/ });
    await expect(around).toContainText("words from the member");
    expect(await insideScreen(card)).toBe(true);
    expect(await insideScreen(around)).toBe(true);
    expect(await noSideways(owner.page)).toBe(true);
  } finally {
    await closeAll([owner, member, reported]);
  }
});
