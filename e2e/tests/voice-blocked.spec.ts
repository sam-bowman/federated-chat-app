import { expect, test, type Page } from "@playwright/test";
import { closeAll, createCommunity, signUp } from "../support/app";

// A person whose network lets the page reach the voice server but not carry the audio (#245): a hotel or office network that only
// allows ordinary web traffic. The server answers, so the join gets as far as the audio connection, and that never comes up.
// They must be told what is wrong, not "try again" as if the server were down.
//
// A test machine cannot block one browser's audio ports, so the browser is told to use RELAYED candidates only
// (`iceTransportPolicy: "relay"`) against a LiveKit that has no relay (e2e/docker-compose.livekit.yml): there is then no way for the
// audio to connect, which is what such a network leaves a person with. Skipped without that LiveKit, like voice.spec.ts.
test.skip(!process.env.E2E_LIVEKIT, "needs a LiveKit server: docker compose -f e2e/docker-compose.livekit.yml up -d, then E2E_LIVEKIT=1");
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

/** Makes the page's peer connections use relayed candidates and nothing else, from before the app runs. */
async function onlyRelayed(page: Page) {
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(configuration?: RTCConfiguration) {
        super({ ...configuration, iceTransportPolicy: "relay" });
      }
      // The voice library sets the configuration again once it has the server's list of relays.
      setConfiguration(configuration?: RTCConfiguration) {
        super.setConfiguration({ ...configuration, iceTransportPolicy: "relay" });
      }
    };
  });
  await page.reload();
}

test("a network that blocks the audio is told so, instead of 'try again'", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await signUp(browser, "a", "olive");
  try {
    await createCommunity(owner.page, "Blocked Club");
    await owner.page.getByTitle("Create channel").click();
    await owner.page.getByRole("radio", { name: "Voice" }).check();
    await owner.page.getByPlaceholder("channel-name").fill("Lounge");
    await owner.page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(owner.page.getByRole("button", { name: "Join voice channel Lounge" })).toBeVisible();

    await onlyRelayed(owner.page);
    await owner.page.getByRole("button", { name: "Join voice channel Lounge" }).click();

    // The library tries the audio connection more than once before it gives up (about a minute).
    await expect(owner.page.getByText(/audio couldn't get through/)).toBeVisible({ timeout: 120_000 });
    await expect(owner.page.getByText("Couldn't connect to the voice server. Try again.")).toHaveCount(0);
    // Nothing is left half joined: no way to leave a call that is not there, and the channel can be tried again.
    await expect(owner.page.getByRole("region", { name: "Voice call" }).getByRole("button", { name: "Leave", exact: true })).toHaveCount(0);
    await expect(owner.page.getByRole("button", { name: "Join voice channel Lounge" })).toBeVisible();
  } finally {
    await closeAll([owner]);
  }
});
