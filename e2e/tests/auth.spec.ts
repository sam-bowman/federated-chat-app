import { expect, test } from "@playwright/test";
import { PASSWORD, clientUrl, closeAll, signUp } from "../support/app";

test("a new person can register, sign out and sign back in", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  try {
    await expect(alice.page.getByText(alice.identity)).toBeVisible();

    await alice.page.getByRole("button", { name: "Sign out" }).click();
    await expect(alice.page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

    await alice.page.getByPlaceholder("username").fill(alice.username);
    await alice.page.getByPlaceholder("password").fill(PASSWORD);
    await alice.page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(alice.page.getByRole("button", { name: "Sign out" })).toBeVisible();
  } finally {
    await closeAll([alice]);
  }
});

test("a wrong password is refused", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  try {
    await alice.page.getByRole("button", { name: "Sign out" }).click();
    await alice.page.getByPlaceholder("username").fill(alice.username);
    await alice.page.getByPlaceholder("password").fill("Not-The-Password-1!");
    await alice.page.getByRole("button", { name: /sign in|log in/i }).click();

    await expect(alice.page.locator(".error-text")).toBeVisible();
    await expect(alice.page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    expect(alice.page.url()).toContain(clientUrl("a"));
  } finally {
    await closeAll([alice]);
  }
});

// The API is reached at localhost:4100 while people's ids say alice.test (the same split as api.example.com vs example.com).
// The identity on the sign-in and register screens used to fall back to the address the API is reached at until the server
// had answered, so an id with the wrong host could be read off the screen and copied.
test("the register screen never shows the API's address as the identity's domain, even while the server is slow to answer", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route("**/.well-known/communication-platform", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto(`${clientUrl("a")}/register`);
    const identity = page.locator(".auth-card code");

    // Before the server has answered there is no domain to show, and it is not guessed.
    await expect(identity).toHaveText("@you:…");
    await expect(page.locator(".auth-card")).not.toContainText("localhost");

    await expect(identity).toHaveText("@you:alice.test");
    await page.getByPlaceholder("username").fill("carol");
    await expect(identity).toHaveText("@carol:alice.test");
  } finally {
    await context.close();
  }
});
