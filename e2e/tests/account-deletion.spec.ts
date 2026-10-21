import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, befriend, closeAll, createCommunity, messageWith, openDm, send, signUp } from "../support/app";
import { SIDES, databaseUrl } from "../support/stack.mjs";

// Deleting an account (#60), end to end in real browsers: asking for it, what it takes, signing in to take it back, and what
// the people still here see once an account has been erased. Erasing happens when the grace period is over (a worker) or at
// once from the operator's command, which is what the last test runs, against the real database of server "a".

// The Settings page has other password fields (Your data, two-factor): this is the one in the delete form.
const deleteForm = (page: Page) => page.locator("form").filter({ hasText: "Type your username" });

async function openDeleteSection(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Delete account" })).toBeVisible();
  await page.getByRole("button", { name: "Delete my account…" }).click();
}

test("asking to delete needs your password and your username, and signing in again cancels it", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  try {
    const { page } = alice;
    await openDeleteSection(page);
    const submit = deleteForm(page).getByRole("button", { name: "Delete my account", exact: true });

    // Nothing can be sent until both are filled in, and the username has to be the person's own.
    await expect(submit).toBeDisabled();
    await deleteForm(page).getByLabel("Your password").fill(PASSWORD);
    await deleteForm(page).getByLabel(/Type your username/).fill("someone_else");
    await expect(submit).toBeDisabled();
    await deleteForm(page).getByLabel(/Type your username/).fill(alice.username);
    await expect(submit).toBeEnabled();

    // A wrong password gets nowhere, and nothing is scheduled.
    await deleteForm(page).getByLabel("Your password").fill("Not-The-Password-1!");
    await submit.click();
    await expect(page.getByText("That is not your password.")).toBeVisible();

    await deleteForm(page).getByLabel("Your password").fill(PASSWORD);
    await submit.click();
    const status = page.getByRole("status").filter({ hasText: "Your account will be erased on" });
    await expect(status).toBeVisible();
    await expect(status).toContainText("Sign in again before then to cancel it");

    // Signed out, and back in: that is how it is cancelled, and the person is told so.
    // The section's own button, which sits right after what it says (the sidebar has a Sign out of its own).
    await status.locator("xpath=following-sibling::button[normalize-space()='Sign out']").click();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await page.getByPlaceholder("username").fill(alice.username);
    await page.getByPlaceholder("password").fill(PASSWORD);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Signing in cancelled that" })).toBeVisible();

    // The notice goes when it has been read, and the account is as it was: asking again offers the same thing.
    await page.getByRole("status").getByRole("button", { name: "OK" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Signing in cancelled that" })).toHaveCount(0);
    await expect(page.getByText(alice.identity)).toBeVisible();
  } finally {
    await closeAll([alice]);
  }
});

test("an owner of a community cannot delete the account until it has been handed on or deleted, and is told which", async ({ browser }) => {
  const owner = await signUp(browser, "a", "olive");
  try {
    const { page } = owner;
    await createCommunity(page, "Olive Club");
    await openDeleteSection(page);
    await deleteForm(page).getByLabel("Your password").fill(PASSWORD);
    await deleteForm(page).getByLabel(/Type your username/).fill(owner.username);
    await deleteForm(page).getByRole("button", { name: "Delete my account", exact: true }).click();

    await expect(page.getByText(/You still own a community/)).toBeVisible();
    await expect(page.getByRole("list").filter({ hasText: "Olive Club" })).toBeVisible();
    // Nothing happened: still signed in.
    await expect(page.getByRole("status").filter({ hasText: "Your account will be erased on" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  } finally {
    await closeAll([owner]);
  }
});

/** The operator's command, run against server "a"'s own database like `npm run admin`, which is how an account is erased at once. */
function operator(...args: string[]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl("a"),
    SERVER_DOMAIN: SIDES.a.domain,
    JWT_ACCESS_SECRET: "e2e-access-secret-a",
    JWT_REFRESH_SECRET: "e2e-refresh-secret-a",
    // The same way the servers find each other here (see scripts/run-server.mjs): `.test` names do not resolve.
    FEDERATION_PEER_OVERRIDES: JSON.stringify({ [SIDES.b.domain]: `http://localhost:${SIDES.b.serverPort}` }),
    NODE_ENV: "development",
  };
  delete env.REDIS_URL;
  delete env.DOTENV_CONFIG_PATH;
  const result = spawnSync(process.execPath, [tsx, "src/adminCli.ts", ...args], { cwd: join(root, "server"), env, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test("once an account is erased, the person it was talking to has the chat with Deleted user, and what it said is gone", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "a", "bella");
  try {
    await befriend(alice, bella);
    await openDm(alice, bella);
    await openDm(bella, alice);
    await send(alice.page, "Message Bella", "hello from alice, soon to be gone");
    await send(bella.page, "Message Alice", "and a reply from bella");
    await expect(messageWith(bella.page, "hello from alice")).toHaveCount(1);
    await expect(messageWith(alice.page, "and a reply")).toHaveCount(1);

    const erased = operator("users", "delete", alice.username, "--now", "--yes");
    expect(erased.code, erased.out).toBe(0);
    expect(erased.out).toContain(`Erased ${alice.username}`);

    // She cannot get back in: the name is gone.
    await alice.page.getByRole("button", { name: "Sign out", exact: true }).click();
    await alice.page.getByPlaceholder("username").fill(alice.username);
    await alice.page.getByPlaceholder("password").fill(PASSWORD);
    await alice.page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(alice.page.locator(".error-text")).toBeVisible();
    await expect(alice.page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);

    // Bella still has the conversation, now with "Deleted user", with her own words and none of Alice's.
    await bella.page.reload();
    const chat = bella.page.getByRole("link", { name: /Deleted user/ });
    await expect(chat).toBeVisible();
    await chat.click();
    await expect(messageWith(bella.page, "and a reply from bella")).toHaveCount(1);
    await expect(bella.page.getByText("hello from alice")).toHaveCount(0);
    await expect(bella.page.getByText(alice.username)).toHaveCount(0);

    // And nobody can take the name.
    const taken = await bella.page.request.post(`http://localhost:${SIDES.a.serverPort}/api/v1/auth/register`, { data: { username: alice.username, password: PASSWORD } });
    expect(taken.status()).toBe(409);
  } finally {
    await closeAll([alice, bella]);
  }
});

test("a friend on another server is told: they forget the person, their messages and the friendship", async ({ browser }) => {
  // The command sends what other servers are to be told before it ends (and the server's worker would find it within minutes if it could not).
  test.setTimeout(150_000);
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await befriend(alice, bella);
    await openDm(alice, bella);
    await openDm(bella, alice);
    await send(alice.page, "Message Bella", "across the wire, then gone");
    await expect(messageWith(bella.page, "across the wire")).toHaveCount(1);

    const erased = operator("users", "delete", alice.username, "--now", "--yes");
    expect(erased.code, erased.out).toBe(0);

    // Bella's server is told and forgets: her friend is gone and the chat is with "Deleted user", without Alice's message.
    await expect
      .poll(
        async () => {
          await bella.page.reload();
          // The sidebar fills in a moment after the page loads, so wait a little before saying it is not there.
          return bella.page
            .getByRole("link", { name: /Deleted user/ })
            .waitFor({ timeout: 4_000 })
            .then(() => 1, () => 0);
        },
        { timeout: 100_000, intervals: [1_000] }
      )
      .toBeGreaterThan(0);
    await bella.page.getByRole("link", { name: /Deleted user/ }).click();
    await expect(bella.page.getByText("across the wire")).toHaveCount(0);
    await goToFriendsAndExpectNone(bella.page, alice.displayName);
  } finally {
    await closeAll([alice, bella]);
  }
});

async function goToFriendsAndExpectNone(page: Page, displayName: string) {
  await page.getByRole("link", { name: /Friends & DMs/ }).click();
  await page.getByRole("tab", { name: /^Friends/ }).click();
  await expect(page.locator(".friend-request-row").filter({ hasText: displayName })).toHaveCount(0);
}
