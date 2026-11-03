import { test } from "@playwright/test";

// Not a test: keeps the e2e stack (the servers, the clients, their databases) up for ten minutes so something else can use it, such as
// the relay lab (e2e/relay-lab/README.md). Skipped unless asked for, so an ordinary run never waits.
test.skip(!process.env.E2E_HOLD, "only for keeping the stack up by hand: E2E_HOLD=1");

test("hold the stack up", async () => {
  test.setTimeout(0);
  await new Promise((resolve) => setTimeout(resolve, 600_000));
});
