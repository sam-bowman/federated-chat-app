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
