import { expect, test, type Page } from "@playwright/test";
import { closeAll, createCommunity, joinCommunity, signUp } from "../support/app";

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
