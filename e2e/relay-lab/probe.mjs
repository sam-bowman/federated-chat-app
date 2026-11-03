// Signs up on the e2e stack, makes a voice channel, joins it, and says how the call connected. Run by run.sh, inside the lab.
import { chromium } from "playwright";

const browser = await chromium.launch({
  // The relay's certificate is the lab's own.
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--ignore-certificate-errors", "--no-sandbox"],
});
const page = await (await browser.newContext()).newPage();
await page.addInitScript(() => {
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(configuration) {
      super(configuration);
      (window.__pcs ??= []).push(this);
    }
  };
});

const name = "lab_" + Math.random().toString(16).slice(2, 8);
await page.goto("http://localhost:5273/register");
await page.getByPlaceholder("username").fill(name);
await page.getByPlaceholder("display name (optional)").fill("Lab");
await page.getByPlaceholder("password").fill("E2e-Test-Pass-9!x");
await page.getByRole("button", { name: /create|register|sign up/i }).click();
await page.getByRole("button", { name: "Sign out" }).waitFor({ timeout: 20000 });
await page.getByRole("button", { name: "Create a community" }).click();
await page.getByPlaceholder("Community name").fill("Lab");
await page.getByRole("button", { name: "Create", exact: true }).click();
await page.waitForURL(/\/communities\/[^/]+/);
await page.getByTitle("Create channel").click();
await page.getByRole("radio", { name: "Voice" }).check();
await page.getByPlaceholder("channel-name").fill("Lounge");
await page.getByRole("button", { name: "Create", exact: true }).click();
const join = page.getByRole("button", { name: "Join voice channel Lounge" });
await join.waitFor();

const started = Date.now();
await join.click();
const failure = page.getByText(/Couldn't connect|audio couldn't get through/).first();
const outcome = await Promise.race([
  page.getByText("Voice connected").waitFor({ timeout: 90000 }).then(() => "CONNECTED"),
  failure.waitFor({ timeout: 90000 }).then(async () => "FAILED: " + (await failure.textContent())),
]);

// The pair the audio really uses: its kind, and for a relayed one how it reached the relay (tls = the TLS port).
const pairs = await page.evaluate(async () => {
  const rows = [];
  for (const pc of window.__pcs ?? []) {
    const stats = await pc.getStats();
    const byId = new Map();
    stats.forEach((r) => byId.set(r.id, r));
    stats.forEach((r) => {
      if (r.type !== "candidate-pair" || !r.nominated || r.state !== "succeeded") return;
      const l = byId.get(r.localCandidateId);
      const remote = byId.get(r.remoteCandidateId);
      rows.push({ local: `${l.candidateType}/${l.protocol}${l.relayProtocol ? "/" + l.relayProtocol : ""}`, remote: `${remote.candidateType}/${remote.protocol}`, via: l.url ?? null });
    });
  }
  return rows;
});
console.log("OUTCOME", outcome, `after ${Math.round((Date.now() - started) / 1000)} s`);
console.log("PAIRS", JSON.stringify(pairs));
await browser.close();
