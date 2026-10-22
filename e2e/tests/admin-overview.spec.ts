import { expect, test } from "@playwright/test";
import { clientUrl, closeAll, domainOf, signUp } from "../support/app";
import { enableTwoFactor, operator } from "../support/operator";
import { SIDES } from "../support/stack.mjs";

// The Overview tab of the admin page (#206), in a real browser: it is where the admin page opens, what it says about the server is what the server itself
// says in its discovery document, and what it counts is live (a new account makes a number go up). The servers here are shared by every spec running at
// once, so exact counts cannot be known: what is checked is what can be: the values the server reports about itself, and a number that must grow.

const countOf = (text: string, label: string) => Number(new RegExp(`${label}(\\d+)`).exec(text)?.[1] ?? Number.NaN);

test("the admin page opens on an overview that says what the server says of itself, and counts what is happening", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await signUp(browser, "a", "overseer");
  const newcomer: { value?: Awaited<ReturnType<typeof signUp>> } = {};
  try {
    const { page } = admin;
    expect(operator("users", "make-admin", admin.username).code).toBe(0);
    await enableTwoFactor(admin);
    const discovery = await (await page.request.get(`http://localhost:${SIDES.a.serverPort}/.well-known/communication-platform`)).json();

    await page.goto(`${clientUrl("a")}/admin`);
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

    await test.step("what it says about the server is what the server says about itself", async () => {
      const server = page.getByRole("region", { name: "Server", exact: true });
      await expect(server).toContainText(discovery.serverName);
      await expect(server).toContainText(discovery.domain);
      await expect(server).toContainText(discovery.serverVersion);
      expect(discovery.domain).toBe(domainOf("a"));

      const other = page.getByRole("region", { name: "Other servers", exact: true });
      await expect(other).toContainText(discovery.features.federation ? "FederationOn" : "FederationOff");
      const features = page.getByRole("region", { name: "Features", exact: true });
      await expect(features).toContainText(`Voice channels${discovery.features.voice ? "On" : "Off"}`);
      await expect(features).toContainText(`Public directory${discovery.features.directory ? "On" : "Off"}`);
      await expect(features).toContainText(`Link previews${discovery.features.linkPreviews ? "On" : "Off"}`);
      // These servers are open: anyone can register (the specs sign up through the form).
      await expect(page.getByRole("region", { name: "Registration", exact: true })).toContainText("Anyone");
    });

    await test.step("it shows the settings in effect, each with the name of the variable that sets it", async () => {
      const settings = page.getByRole("region", { name: "Settings in effect", exact: true });
      await expect(settings.locator("code", { hasText: "ACCOUNT_DELETION_GRACE_DAYS" })).toBeVisible();
      await expect(settings.locator("code", { hasText: "AUDIT_LOG_RETENTION_DAYS" })).toBeVisible();
      await expect(settings).toContainText("Largest file that can be uploaded");
      await expect(settings).toContainText("restart");
    });

    const people = page.getByRole("region", { name: "People", exact: true });
    const before = countOf((await people.textContent()) ?? "", "Accounts");
    expect(before).toBeGreaterThanOrEqual(1);
    expect(countOf((await people.textContent()) ?? "", "Admins")).toBeGreaterThanOrEqual(1);

    await test.step("a new account makes the number go up when it is refreshed", async () => {
      newcomer.value = await signUp(browser, "a", "newcomer");
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect.poll(async () => countOf((await people.textContent()) ?? "", "Accounts")).toBeGreaterThanOrEqual(before + 1);
      expect(countOf((await people.textContent()) ?? "", "Joined in the last week")).toBeGreaterThanOrEqual(2);
      await expect(page.getByText(/^As of /)).toBeVisible();
    });

    await test.step("the other tabs are still one click away", async () => {
      await page.getByRole("tab", { name: "Users" }).click();
      await expect(page.getByLabel("Find an account")).toBeVisible();
      await page.getByRole("tab", { name: "Overview" }).click();
      await expect(page.getByRole("region", { name: "Server", exact: true })).toBeVisible();
    });
  } finally {
    await closeAll([admin, ...(newcomer.value ? [newcomer.value] : [])]);
  }
});
