import { expect, test, type Page } from "@playwright/test";
import { alertsOf, befriend, closeAll, createCommunity, joinCommunity, openDm, setFocused, signUp, watchAlerts } from "../support/app";

// Voice channels (#53), end to end: two real browsers on the real client, a real server, and a real LiveKit (see
// e2e/docker-compose.livekit.yml). Skipped without one, so a local run that did not start it still passes.
//
// The browsers get fake microphones, and the permission prompt is answered for them.
test.skip(!process.env.E2E_LIVEKIT, "needs a LiveKit server: docker compose -f e2e/docker-compose.livekit.yml up -d, then E2E_LIVEKIT=1");
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

/** Makes a voice channel through the dialog, and waits until it is in the sidebar. */
async function addVoiceChannel(page: Page, name: string) {
  await page.getByTitle("Create channel").click();
  await page.getByRole("radio", { name: "Voice" }).check();
  await page.getByPlaceholder("channel-name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: `Join voice channel ${name}` })).toBeVisible();
}

// The call panel's own buttons (the page header has a "Leave" of its own, for the community).
const panel = (page: Page) => page.getByRole("region", { name: "Voice call" });

/**
 * The call's sound goes through the Web Audio API (one gain node per person, which is where their volume lives), so a test cannot ask
 * an <audio> element whether it is playing. This records every gain node that is joined to the speakers, from before the page runs
 * (so it reloads once), and reads their volumes back.
 */
async function watchPlayback(page: Page) {
  await page.addInitScript(() => {
    const heard = new Set<GainNode>();
    (window as unknown as Record<string, unknown>).__heard = heard;
    const connect = AudioNode.prototype.connect as (...args: unknown[]) => unknown;
    (AudioNode.prototype as unknown as { connect: unknown }).connect = function (this: AudioNode, target: unknown, ...rest: unknown[]) {
      if (this instanceof GainNode && target instanceof AudioDestinationNode) heard.add(this);
      return connect.call(this, target, ...rest);
    };
  });
  await page.reload();
}

/** The volumes, as multiples of normal, of the people whose sound is reaching the speakers (a person at zero is not listed). */
const volumes = (page: Page) =>
  page.evaluate(() =>
    [...((window as unknown as { __heard: Set<GainNode> }).__heard ?? [])]
      .map((gain) => Math.round(gain.gain.value * 100) / 100)
      .filter((v) => v > 0.001)
      .sort(),
  );
const playingAudio = async (page: Page) => (await volumes(page)).length;

test("two people in a voice channel see each other, hear each other, and can mute and leave", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const member = await signUp(browser, "a", "max");
  try {
    await watchPlayback(owner.page);
    await watchPlayback(member.page);
    const communityId = await createCommunity(owner.page, "Voice Club");
    await joinCommunity(member.page, "Voice Club", communityId);
    await member.page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name: "Voice Club" }).click();

    await addVoiceChannel(owner.page, "Lounge");
    // A voice channel is something to join, not a page: there is no link to open.
    await expect(owner.page.locator('a[href*="/communities/"]', { hasText: "Lounge" })).toHaveCount(0);
    await expect(member.page.getByRole("button", { name: "Join voice channel Lounge" })).toBeVisible();

    // The owner joins; the member, who has not joined, is told by the server who is in.
    await owner.page.getByRole("button", { name: "Join voice channel Lounge" }).click();
    await expect(owner.page.getByText("Voice connected")).toBeVisible();
    const ownerList = (page: Page) => page.getByRole("list", { name: "In Lounge" });
    await expect(ownerList(member.page).getByText("Olive")).toBeVisible();
    await expect(member.page.locator(".voice-count")).toHaveText("1");

    // The member joins: both see both.
    await member.page.getByRole("button", { name: "Join voice channel Lounge" }).click();
    await expect(member.page.getByText("Voice connected")).toBeVisible();
    await expect(owner.page.locator(".voice-person")).toHaveCount(2);
    await expect(member.page.locator(".voice-person")).toHaveCount(2);

    // Each hears the other (the call's audio is playing).
    await expect.poll(() => playingAudio(owner.page)).toBeGreaterThanOrEqual(1);
    await expect.poll(() => playingAudio(member.page)).toBeGreaterThanOrEqual(1);

    // The member mutes, and the owner sees it.
    await member.page.getByRole("button", { name: "Mute", exact: true }).click();
    await expect(member.page.getByRole("button", { name: "Unmute", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(owner.page.locator(".voice-person", { hasText: "Max" }).getByRole("img", { name: "microphone off" })).toBeVisible();
    await member.page.getByRole("button", { name: "Unmute", exact: true }).click();
    await expect(owner.page.locator(".voice-person", { hasText: "Max" }).getByRole("img", { name: "microphone off" })).toHaveCount(0);

    // Deafening stops what the member hears.
    await member.page.getByRole("button", { name: "Deafen", exact: true }).click();
    await expect.poll(() => playingAudio(member.page)).toBe(0);
    await member.page.getByRole("button", { name: "Undeafen", exact: true }).click();
    await expect.poll(() => playingAudio(member.page)).toBeGreaterThanOrEqual(1);

    // The member leaves: the owner's list is down to one, and the member's panel is gone.
    await panel(member.page).getByRole("button", { name: "Leave", exact: true }).click();
    await expect(member.page.getByRole("region", { name: "Voice call" })).toHaveCount(0);
    await expect(owner.page.locator(".voice-person")).toHaveCount(1);

    // The owner leaves: nobody is in it.
    await panel(owner.page).getByRole("button", { name: "Leave", exact: true }).click();
    await expect(owner.page.getByRole("region", { name: "Voice call" })).toHaveCount(0);
    await expect(member.page.getByRole("list", { name: "In Lounge" })).toHaveCount(0);
  } finally {
    await closeAll([owner, member]);
  }
});

test("removing someone from the community ends their call, and tells them why", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const member = await signUp(browser, "a", "max");
  try {
    const communityId = await createCommunity(owner.page, "Voice Club 2");
    await joinCommunity(member.page, "Voice Club 2", communityId);
    await member.page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name: "Voice Club 2" }).click();
    await addVoiceChannel(owner.page, "Lounge");

    await member.page.getByRole("button", { name: "Join voice channel Lounge" }).click();
    await expect(member.page.getByText("Voice connected")).toBeVisible();

    // The owner removes the member from the community (Settings -> Members -> Kick).
    await owner.page.locator("main").getByRole("button", { name: "Settings", exact: true }).click();
    await owner.page.getByRole("tab", { name: "Members" }).click();
    await owner.page.getByRole("button", { name: "Kick", exact: true }).click();
    await owner.page.getByRole("dialog", { name: "Kick member" }).getByRole("button", { name: "Kick", exact: true }).click();

    await expect(member.page.getByText("You were removed from the call.")).toBeVisible();
    await expect(panel(member.page).getByRole("button", { name: "Leave", exact: true })).toHaveCount(0);
  } finally {
    await closeAll([owner, member]);
  }
});

test("each person sets how loud the others are for them alone, and it is remembered", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const member = await signUp(browser, "a", "max");
  try {
    await watchPlayback(owner.page);
    await watchPlayback(member.page);
    const communityId = await createCommunity(owner.page, "Voice Club 3");
    await joinCommunity(member.page, "Voice Club 3", communityId);
    await member.page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name: "Voice Club 3" }).click();
    await addVoiceChannel(owner.page, "Lounge");
    await owner.page.getByRole("button", { name: "Join voice channel Lounge" }).click();
    await member.page.getByRole("button", { name: "Join voice channel Lounge" }).click();
    await expect(owner.page.locator(".voice-person")).toHaveCount(2);
    await expect(member.page.locator(".voice-person")).toHaveCount(2);
    await expect.poll(() => volumes(member.page)).toEqual([1]);
    await expect.poll(() => volumes(owner.page)).toEqual([1]);

    // The member turns Olive up to 150%: only the member's speakers change.
    await member.page.getByRole("button", { name: "Volume for Olive" }).click();
    await member.page.getByRole("slider", { name: "Olive's volume" }).fill("150");
    await expect(member.page.getByRole("button", { name: "Volume for Olive" })).toContainText("150%");
    await expect.poll(() => volumes(member.page)).toEqual([1.5]);
    expect(await volumes(owner.page)).toEqual([1]);

    // Muting for oneself silences her for the member, and still not for anyone else.
    await member.page.getByLabel("Mute for me").check();
    await expect.poll(() => volumes(member.page)).toEqual([]);
    expect(await volumes(owner.page)).toEqual([1]);
    await member.page.getByLabel("Mute for me").uncheck();
    await expect.poll(() => volumes(member.page)).toEqual([1.5]);

    // The master volume scales everyone, on top of each person.
    await member.page.getByRole("button", { name: "Settings", exact: true }).click();
    await member.page.getByRole("slider", { name: "Master volume" }).fill("50");
    await expect.poll(() => volumes(member.page)).toEqual([0.75]);
    await expect(member.page.getByText("Voice connected")).toBeVisible(); // still in the call while in Settings
    await expect(member.page.getByText(owner.identity)).toBeVisible(); // listed under "People you have adjusted"

    // Remembered: leave, reload, and join again.
    await panel(member.page).getByRole("button", { name: "Leave", exact: true }).click();
    await member.page.reload();
    await member.page.getByRole("link", { name: "Voice Club 3" }).click();
    await member.page.getByRole("button", { name: "Join voice channel Lounge" }).click();
    await expect(member.page.locator(".voice-person")).toHaveCount(2);
    await expect.poll(() => volumes(member.page)).toEqual([0.75]);
  } finally {
    await closeAll([owner, member]);
  }
});

test("calling a friend in a direct chat: they are told, can join, hear each other, and the call ends when both have left", async ({ browser }) => {
  const olive = await signUp(browser, "a", "olive");
  const max = await signUp(browser, "a", "max");
  try {
    await watchPlayback(olive.page);
    await watchPlayback(max.page);
    await befriend(olive, max);
    await openDm(olive, max);

    await olive.page.getByRole("button", { name: "Start call", exact: true }).click();
    await expect(olive.page.getByText("Voice connected")).toBeVisible();
    await expect(olive.page.getByRole("button", { name: "Leave call", exact: true })).toBeVisible();

    // Max is told, wherever they are, and joins from the banner.
    const banner = max.page.getByRole("region", { name: "Incoming calls" });
    await expect(banner.getByText("Olive is calling you")).toBeVisible();
    await banner.getByRole("button", { name: "Join the call in Olive" }).click();
    await expect(max.page.getByText("Voice connected")).toBeVisible();
    await expect(max.page).toHaveURL(/\/dm\//);
    await expect(max.page.getByRole("region", { name: "Incoming calls" })).toHaveCount(0);

    // Both are listed, in both windows, and each hears the other.
    await expect(olive.page.locator(".conversation-call .voice-person")).toHaveCount(2);
    await expect(max.page.locator(".conversation-call .voice-person")).toHaveCount(2);
    await expect.poll(() => volumes(olive.page)).toEqual([1]);
    await expect.poll(() => volumes(max.page)).toEqual([1]);

    // Olive leaves; Max is still in it, so Olive can come back.
    await olive.page.getByRole("button", { name: "Leave call", exact: true }).click();
    await expect(olive.page.getByRole("button", { name: "Join call", exact: true })).toBeVisible();
    await expect(max.page.locator(".conversation-call .voice-person")).toHaveCount(1);

    // The last one leaves: the call is over for both.
    await panel(max.page).getByRole("button", { name: "Leave", exact: true }).click();
    await expect(olive.page.getByRole("button", { name: "Start call", exact: true })).toBeVisible();
    await expect(olive.page.locator(".conversation-call")).toHaveCount(0);
  } finally {
    await closeAll([olive, max]);
  }
});

test("a call that has just started rings and notifies, until it is put away, and a new call after it rings again", async ({ browser }) => {
  const olive = await signUp(browser, "a", "olive");
  const max = await signUp(browser, "a", "max");
  try {
    await befriend(olive, max);
    await openDm(olive, max);
    await watchAlerts(max.page);
    await setFocused(max.page, false);

    await olive.page.getByRole("button", { name: "Start call", exact: true }).click();
    await expect(olive.page.getByText("Voice connected")).toBeVisible();
    const banner = max.page.getByRole("region", { name: "Incoming calls" });
    await expect(banner.getByText("Olive is calling you")).toBeVisible();
    await expect.poll(async () => (await alertsOf(max.page)).sounds).toBeGreaterThanOrEqual(1);
    expect((await alertsOf(max.page)).notifications.map((n) => n.title)).toEqual(["Olive is calling"]);

    // Put away: the banner goes and the ringing stops, though the call goes on.
    await banner.getByRole("button", { name: "Dismiss the call in Olive" }).click();
    await expect(max.page.getByRole("region", { name: "Incoming calls" })).toHaveCount(0);
    const rung = (await alertsOf(max.page)).sounds;
    await max.page.waitForTimeout(3500); // longer than the gap between rings: proving something does NOT happen
    expect((await alertsOf(max.page)).sounds).toBe(rung);
    await expect(olive.page.getByRole("button", { name: "Leave call", exact: true })).toBeVisible();

    // Olive ends it and starts another: that one is new, so it rings and shows again.
    await olive.page.getByRole("button", { name: "Leave call", exact: true }).click();
    await expect(olive.page.getByRole("button", { name: "Start call", exact: true })).toBeVisible();
    await olive.page.getByRole("button", { name: "Start call", exact: true }).click();
    await expect(banner.getByText("Olive is calling you")).toBeVisible();
    await expect.poll(async () => (await alertsOf(max.page)).sounds).toBeGreaterThan(rung);
  } finally {
    await closeAll([olive, max]);
  }
});

// #220: the owner had already loaded the app (and was in the call) when this person joined the community, so the owner's cached
// member list did not have them. They were in the call, and heard, but missing from the owner's list for good.
test("someone who joins the community after you loaded it still shows up in a voice channel", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  try {
    const communityId = await createCommunity(owner.page, "Late Joiners");
    await addVoiceChannel(owner.page, "Lounge");
    await owner.page.getByRole("button", { name: "Join voice channel Lounge" }).click();
    await expect(owner.page.getByText("Voice connected")).toBeVisible();

    const late = await signUp(browser, "a", "max");
    try {
      await joinCommunity(late.page, "Late Joiners", communityId);
      await late.page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name: "Late Joiners" }).click();
      await late.page.getByRole("button", { name: "Join voice channel Lounge" }).click();
      await expect(late.page.getByText("Voice connected")).toBeVisible();

      const list = owner.page.getByRole("list", { name: "In Lounge" });
      await expect(list.getByText("Max")).toBeVisible();
      await expect(owner.page.locator(".voice-person")).toHaveCount(2);

      // And when they leave the call, they go from the list.
      await late.page.getByRole("button", { name: "Leave voice channel Lounge" }).click();
      await expect(owner.page.locator(".voice-person")).toHaveCount(1);
    } finally {
      await closeAll([late]);
    }
  } finally {
    await closeAll([owner]);
  }
});

// Phone layout (#219): while a page is open the lists, where the call panel lives, are not on screen. The controls follow the person.
test("on a phone the call controls stay in reach while reading a channel", async ({ browser }) => {
  const person = await signUp(browser, "a", "olive");
  try {
    const { page } = person;
    await createCommunity(page, "Phone Call Club");
    await addVoiceChannel(page, "Lounge");
    await page.setViewportSize({ width: 375, height: 667 });
    await page.getByRole("button", { name: /^‹/ }).click();
    await page.getByRole("button", { name: "Join voice channel Lounge" }).click();
    await expect(page.getByText("Voice connected")).toBeVisible();

    // Open the text channel: the list is gone, the call controls are not.
    await page.getByRole("link", { name: /# general/ }).click();
    await expect(page.getByPlaceholder(/Message #general/)).toBeVisible();
    const call = panel(page);
    await expect(call).toBeVisible();
    const mute = call.getByRole("button", { name: "Mute", exact: true });
    await mute.click();
    await expect(call.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
    const box = (await call.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(375.5);

    await call.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page.getByRole("region", { name: "Voice call" })).toHaveCount(0);
  } finally {
    await closeAll([person]);
  }
});

test("on a phone an incoming call banner fits the screen and can be answered", async ({ browser }) => {
  const olive = await signUp(browser, "a", "olive");
  const max = await signUp(browser, "a", "max");
  try {
    await befriend(olive, max);
    await openDm(olive, max);
    await max.page.setViewportSize({ width: 375, height: 667 }); // the helpers above are written for a wide window
    await olive.page.getByRole("button", { name: "Start call", exact: true }).click();
    await expect(olive.page.getByText("Voice connected")).toBeVisible();

    const banner = max.page.getByRole("region", { name: "Incoming calls" });
    await expect(banner.getByText("Olive is calling you")).toBeVisible();
    const box = (await banner.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375.5);
    await banner.getByRole("button", { name: "Join the call in Olive" }).click();
    await expect(max.page.getByText("Voice connected")).toBeVisible();
    // In the chat, with the call controls above it.
    await expect(max.page.getByPlaceholder(/Message Olive/)).toBeVisible();
    await expect(panel(max.page).getByRole("button", { name: "Leave", exact: true })).toBeVisible();
  } finally {
    await closeAll([olive, max]);
  }
});

// Call quality readout: real numbers from a real connection, read from the browser's own statistics.
test("the call quality readout shows real numbers for a call, and what kind of connection it is", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const member = await signUp(browser, "a", "max");
  try {
    const communityId = await createCommunity(owner.page, "Quality Club");
    await joinCommunity(member.page, "Quality Club", communityId);
    await member.page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name: "Quality Club" }).click();
    await addVoiceChannel(owner.page, "Lounge");
    await owner.page.getByRole("button", { name: "Join voice channel Lounge" }).click();
    await member.page.getByRole("button", { name: "Join voice channel Lounge" }).click();
    await expect(owner.page.locator(".voice-person")).toHaveCount(2);
    await expect(member.page.locator(".voice-person")).toHaveCount(2);

    await panel(member.page).getByRole("button", { name: "Quality", exact: true }).click();
    const readout = member.page.getByRole("group", { name: "Call quality" });
    await expect(readout).toBeVisible();
    const value = (label: string) => readout.getByText(label, { exact: true }).locator("xpath=following-sibling::dd[1]");

    // The numbers arrive once audio has flowed for a moment.
    await expect(value("Round trip to the voice server")).toHaveText(/^\d+ ms$/, { timeout: 15000 });
    await expect(value("Audio waits before playing")).toHaveText(/^\d+ ms$/, { timeout: 15000 });
    await expect(value("Connection")).toHaveText(/^(UDP|TCP)/);
    await expect(readout.getByRole("status")).toHaveText(/^(Good|Fair|Poor)$/);
    const delay = parseInt((await value("Delay (network and buffering)").textContent()) ?? "", 10);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThan(1000);

    // Closing it stops it.
    await panel(member.page).getByRole("button", { name: "Quality", exact: true }).click();
    await expect(readout).toHaveCount(0);
  } finally {
    await closeAll([owner, member]);
  }
});
