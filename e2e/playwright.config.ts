import { defineConfig } from "@playwright/test";
import { SIDES } from "./support/stack.mjs";

// The real client in a real browser against two real homeservers (alice.test and bob.test) that talk to each other over
// the signed federation protocol, like the two-server demo. See docs/testing.md "End-to-end tests".

const a = SIDES.a;
const b = SIDES.b;
// The servers' and Vite's own output is only worth reading when something is wrong: E2E_VERBOSE=1 shows all of it.
const started = {
  reuseExistingServer: !process.env.CI,
  timeout: 180_000,
  stdout: process.env.E2E_VERBOSE ? "pipe" : "ignore",
  stderr: "pipe",
} as const;
const vite = (side: "a" | "b") => ({
  command: `npx vite --mode ${side} --port ${SIDES[side].clientPort} --strictPort`,
  cwd: "../client",
  url: `http://localhost:${SIDES[side].clientPort}`,
  // The client reads where its server is from this, the same variable client/.env.a and client/.env.b set for the demo.
  env: { VITE_API_URL: `http://localhost:${SIDES[side].serverPort}` },
  ...started,
});

export default defineConfig({
  testDir: "./tests",
  // Every test makes its own users, so tests do not need to wait for each other; the servers are the shared part.
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    // CI uses the Chromium Playwright downloads. Locally, set E2E_BROWSER_CHANNEL=msedge (or chrome) to use a browser
    // that is already installed instead of downloading one.
    channel: process.env.E2E_BROWSER_CHANNEL || undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    { command: "node scripts/run-server.mjs a", url: `http://localhost:${a.serverPort}/healthz`, ...started },
    { command: "node scripts/run-server.mjs b", url: `http://localhost:${b.serverPort}/healthz`, ...started },
    vite("a"),
    vite("b"),
  ],
});
