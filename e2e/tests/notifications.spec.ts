import { expect, test } from "@playwright/test";
import {
  alertsOf,
  befriend,
  closeAll,
  createCommunity,
  goToFriends,
  joinCommunity,
  messageWith,
  openCommunity,
  openDm,
  send,
  setFocused,
  signUp,
  watchAlerts,
  type Person,
} from "../support/app";

// Sounds and system notifications when a message arrives (#47's local half). The browser's audio engine and Notification API are
// stood in for (`watchAlerts`) so the test can see what the app asked for. The app lets one sound through in 1.2 s, so a test that
// expects a second sound waits that long first.
const AFTER_THE_GAP = 1400;

async function twoFriends(browser: Parameters<typeof signUp>[0]): Promise<{ alice: Person; ben: Person }> {
  const alice = await signUp(browser, "a", "alice");
  const ben = await signUp(browser, "a", "ben");
  await befriend(alice, ben);
  await openDm(alice, ben);
  await watchAlerts(ben.page);
  return { alice, ben };
}

test("a message for a chat you are not reading makes a sound and a notification; the one you are reading, in focus, does not", async ({ browser }) => {
  const { alice, ben } = await twoFriends(browser);
  try {
    // Ben is on the friends page, reading nothing: he hears and sees it.
    await goToFriends(ben.page);
    await send(alice.page, "Message Ben", "first one");
    await expect.poll(async () => (await alertsOf(ben.page)).notifications.length).toBe(1);
    let alerts = await alertsOf(ben.page);
    expect(alerts.sounds).toBe(1);
    expect(alerts.notifications[0]).toEqual({ title: "Alice", body: "first one" });

    // Ben opens the conversation and the app has focus: nothing for what he is reading.
    await openDm(ben, alice);
    await ben.page.waitForTimeout(AFTER_THE_GAP);
    await send(alice.page, "Message Ben", "second one");
    await expect(messageWith(ben.page, "second one")).toHaveCount(1);
    await ben.page.waitForTimeout(500);
    alerts = await alertsOf(ben.page);
    expect(alerts.sounds).toBe(1);
    expect(alerts.notifications).toHaveLength(1);

    // The app loses focus (another window in front): now it counts, even for the open conversation.
    await setFocused(ben.page, false);
    await send(alice.page, "Message Ben", "third one");
    await expect.poll(async () => (await alertsOf(ben.page)).notifications.length).toBe(2);
    alerts = await alertsOf(ben.page);
    expect(alerts.sounds).toBe(2);
    expect(alerts.notifications[1]).toEqual({ title: "Alice", body: "third one" });
  } finally {
    await closeAll([alice, ben]);
  }
});

test("a message for another place still makes a sound while the app has focus", async ({ browser }) => {
  const { alice, ben } = await twoFriends(browser);
  try {
    const name = `Club ${Date.now().toString(36)}`;
    const id = await createCommunity(ben.page, name);
    await expect(ben.page.getByPlaceholder("Message #general")).toBeVisible();
    // Ben is reading #general of his own community, and Alice (a friend) writes to him directly.
    expect(id).toBeTruthy();
    await send(alice.page, "Message Ben", "over here");
    await expect.poll(async () => (await alertsOf(ben.page)).notifications.length).toBe(1);
    expect((await alertsOf(ben.page)).sounds).toBe(1);
  } finally {
    await closeAll([alice, ben]);
  }
});

test("each can be turned off for one conversation from its bell, and that follows the person to another tab", async ({ browser }) => {
  const { alice, ben } = await twoFriends(browser);
  try {
    await goToFriends(ben.page);
    await openDm(ben, alice);
    await ben.page.getByRole("button", { name: /Sound and notifications/ }).click();
    const dialog = ben.page.getByRole("dialog", { name: "Notifications for Alice" });
    const saved = ben.page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/notification-settings") && r.ok());
    await dialog.getByLabel("Sound").selectOption("off");
    await saved;
    await ben.page.keyboard.press("Escape");
    await goToFriends(ben.page);

    // Sound off for this conversation, notification still on.
    await send(alice.page, "Message Ben", "no sound please");
    await expect.poll(async () => (await alertsOf(ben.page)).notifications.length).toBe(1);
    expect((await alertsOf(ben.page)).sounds).toBe(0);

    // It was saved on the server: a second tab for the same person has it from the start.
    const second = await ben.context.newPage();
    await second.goto(ben.page.url());
    await watchAlerts(second);
    await alice.page.waitForTimeout(AFTER_THE_GAP);
    await send(alice.page, "Message Ben", "and again");
    await expect.poll(async () => (await alertsOf(second)).notifications.length).toBe(1);
    expect((await alertsOf(second)).sounds).toBe(0);

    // And turning the notification off too, from the other tab, reaches this one as it is made (this one is looking at the
    // conversation, where the bell shows what is on).
    await openDm(ben, alice);
    await expect(ben.page.getByRole("button", { name: "Sound and notifications", exact: true })).toBeVisible();
    await second.getByRole("link", { name: /Friends & DMs/ }).click();
    await openDm({ ...ben, page: second }, alice);
    await second.getByRole("button", { name: /Sound and notifications/ }).click();
    await second.getByRole("dialog", { name: "Notifications for Alice" }).getByLabel("System notification").selectOption("off");
    await expect(ben.page.getByRole("button", { name: "Sound and notifications (muted)" })).toBeVisible();
    await second.close();
  } finally {
    await closeAll([alice, ben]);
  }
});

test("turning both off in Settings silences everything, and a place that chooses for itself still gets through", async ({ browser }) => {
  const { alice, ben } = await twoFriends(browser);
  try {
    await ben.page.getByRole("button", { name: "Settings" }).click();
    await ben.page.getByRole("checkbox", { name: "Play a sound when a message arrives" }).uncheck();
    await ben.page.getByRole("checkbox", { name: "Show a system notification when a message arrives" }).uncheck();
    await expect(ben.page.getByRole("checkbox", { name: "Play a sound when a message arrives" })).not.toBeChecked();
    await goToFriends(ben.page);

    await send(alice.page, "Message Ben", "silence");
    await ben.page.waitForTimeout(1000);
    let alerts = await alertsOf(ben.page);
    expect(alerts.sounds).toBe(0);
    expect(alerts.notifications).toHaveLength(0);

    // Ben chooses "on" for this one conversation: it beats the global choice.
    await openDm(ben, alice);
    await ben.page.getByRole("button", { name: /Sound and notifications/ }).click();
    const saved = ben.page.waitForResponse((r) => r.request().method() === "PUT" && r.ok());
    await ben.page.getByRole("dialog", { name: "Notifications for Alice" }).getByLabel("Sound").selectOption("on");
    await saved;
    await ben.page.keyboard.press("Escape");
    await goToFriends(ben.page);
    await ben.page.waitForTimeout(AFTER_THE_GAP);

    await send(alice.page, "Message Ben", "this one gets through");
    await expect.poll(async () => (await alertsOf(ben.page)).sounds).toBe(1);
    alerts = await alertsOf(ben.page);
    // The sound was chosen for it; the notification still follows the global choice, which is off.
    expect(alerts.notifications).toHaveLength(0);
  } finally {
    await closeAll([alice, ben]);
  }
});

test("a channel's own choice beats its community's, and a community's covers all its channels", async ({ browser }) => {
  const { alice, ben } = await twoFriends(browser);
  try {
    // Alice makes a community with a second channel; Ben joins.
    const communityName = `Club ${Date.now().toString(36)}`;
    const communityId = await createCommunity(alice.page, communityName);
    await alice.page.getByTitle("Create channel").click();
    await alice.page.getByPlaceholder("channel-name").fill("random");
    await alice.page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(alice.page.getByPlaceholder("Message #random")).toBeVisible();
    await joinCommunity(ben.page, communityName, communityId);
    await openCommunity(ben.page, communityName);
    await expect(ben.page.getByPlaceholder("Message #general")).toBeVisible();

    // Ben mutes the whole community from the bell.
    await ben.page.getByRole("button", { name: /Sound and notifications/ }).click();
    const dialog = ben.page.getByRole("dialog", { name: "Notifications for #general" });
    const saved = ben.page.waitForResponse((r) => r.request().method() === "PUT" && r.ok());
    await dialog.getByRole("heading", { name: `All of ${communityName}` }).waitFor();
    await dialog.getByLabel("Sound").nth(1).selectOption("off");
    await saved;
    const savedAgain = ben.page.waitForResponse((r) => r.request().method() === "PUT" && r.ok());
    await dialog.getByLabel("System notification").nth(1).selectOption("off");
    await savedAgain;
    await ben.page.keyboard.press("Escape");
    await goToFriends(ben.page);

    // Alice writes in #random (Ben's community is muted): nothing.
    await alice.page.getByRole("link", { name: "# random" }).click().catch(() => {});
    await alice.page.getByPlaceholder("Message #random").fill("quiet");
    await alice.page.getByRole("button", { name: "Send", exact: true }).click();
    await ben.page.waitForTimeout(1000);
    let alerts = await alertsOf(ben.page);
    expect(alerts.sounds).toBe(0);
    expect(alerts.notifications).toHaveLength(0);

    // Ben turns the sound on for #general only: it beats the muted community.
    await openCommunity(ben.page, communityName);
    await ben.page.getByRole("button", { name: /Sound and notifications/ }).click();
    const saved2 = ben.page.waitForResponse((r) => r.request().method() === "PUT" && r.ok());
    await ben.page.getByRole("dialog", { name: "Notifications for #general" }).getByLabel("Sound").first().selectOption("on");
    await saved2;
    await ben.page.keyboard.press("Escape");
    await goToFriends(ben.page);
    await ben.page.waitForTimeout(AFTER_THE_GAP);

    await alice.page.getByRole("link", { name: "# general" }).click();
    await alice.page.getByPlaceholder("Message #general").fill("loud");
    await alice.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => (await alertsOf(ben.page)).sounds).toBe(1);
    alerts = await alertsOf(ben.page);
    expect(alerts.notifications).toHaveLength(0);
  } finally {
    await closeAll([alice, ben]);
  }
});

test("the channel you are reading is silent while the app has focus, and another channel of the same community is not", async ({ browser }) => {
  const { alice, ben } = await twoFriends(browser);
  try {
    const communityName = `Club ${Date.now().toString(36)}`;
    const communityId = await createCommunity(alice.page, communityName);
    await alice.page.getByTitle("Create channel").click();
    await alice.page.getByPlaceholder("channel-name").fill("random");
    await alice.page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(alice.page.getByPlaceholder("Message #random")).toBeVisible();
    await joinCommunity(ben.page, communityName, communityId);
    await openCommunity(ben.page, communityName);
    await expect(ben.page.getByPlaceholder("Message #general")).toBeVisible();

    // Ben is reading #general, with focus: a message there is not announced to him.
    await alice.page.getByRole("link", { name: "# general" }).click();
    await alice.page.getByPlaceholder("Message #general").fill("in the channel you are reading");
    await alice.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(messageWith(ben.page, "in the channel you are reading")).toHaveCount(1);
    await ben.page.waitForTimeout(600);
    let alerts = await alertsOf(ben.page);
    expect(alerts.sounds).toBe(0);
    expect(alerts.notifications).toHaveLength(0);

    // Another channel of the same community is.
    await alice.page.getByRole("link", { name: "# random" }).click();
    await alice.page.getByPlaceholder("Message #random").fill("somewhere else");
    await alice.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => (await alertsOf(ben.page)).notifications.length).toBe(1);
    alerts = await alertsOf(ben.page);
    expect(alerts.sounds).toBe(1);
    expect(alerts.notifications[0]).toEqual({ title: `Alice in #random (${communityName})`, body: "somewhere else" });

    // And with the app out of focus, the open channel counts again.
    await setFocused(ben.page, false);
    await ben.page.waitForTimeout(AFTER_THE_GAP);
    await alice.page.getByRole("link", { name: "# general" }).click();
    await alice.page.getByPlaceholder("Message #general").fill("now you are away");
    await alice.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => (await alertsOf(ben.page)).notifications.length).toBe(2);
  } finally {
    await closeAll([alice, ben]);
  }
});

test("settings are kept on the server: they are still there after signing in again", async ({ browser }) => {
  const { alice, ben } = await twoFriends(browser);
  try {
    await ben.page.getByRole("button", { name: "Settings" }).click();
    const saved = ben.page.waitForResponse((r) => r.request().method() === "PUT" && r.ok());
    await ben.page.getByRole("checkbox", { name: "Play a sound when a message arrives" }).uncheck();
    await saved;
    await ben.page.evaluate(() => localStorage.clear());
    await ben.page.reload();
    // Cleared storage signs the person out; sign back in with the same account.
    await ben.page.getByPlaceholder("username").fill(ben.username);
    await ben.page.getByPlaceholder("password").fill("E2e-Test-Pass-9!x");
    await ben.page.getByRole("button", { name: /sign in|log in/i }).click();
    await ben.page.getByRole("button", { name: "Settings" }).click();
    await expect(ben.page.getByRole("checkbox", { name: "Play a sound when a message arrives" })).not.toBeChecked();
  } finally {
    await closeAll([alice, ben]);
  }
});
