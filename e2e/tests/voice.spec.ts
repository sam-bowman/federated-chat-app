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

const playingAudio = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("audio")].filter((el) => !el.paused && !el.muted).length);

test("two people in a voice channel see each other, hear each other, and can mute and leave", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  const member = await signUp(browser, "a", "max");
  try {
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
