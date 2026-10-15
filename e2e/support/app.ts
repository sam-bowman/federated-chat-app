import { randomBytes } from "node:crypto";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { SIDES } from "./stack.mjs";

export type Side = "a" | "b";

/** Meets the server's password rules. Only ever used on the throwaway servers this suite starts. */
export const PASSWORD = "E2e-Test-Pass-9!x";

export const clientUrl = (side: Side) => `http://localhost:${SIDES[side].clientPort}`;
export const domainOf = (side: Side) => SIDES[side].domain;

/** A username no other test is using (every test makes its own people, so tests never depend on one another). */
export function uniqueName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export interface Person {
  side: Side;
  username: string;
  displayName: string;
  /** `@name:domain`, what another server calls them. */
  identity: string;
  context: BrowserContext;
  page: Page;
}

/** Registers a new account through the real sign-up form and returns the signed-in person, in a browser of their own. */
export async function signUp(browser: Browser, side: Side, prefix: string): Promise<Person> {
  const username = uniqueName(prefix);
  const displayName = prefix[0].toUpperCase() + prefix.slice(1);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${clientUrl(side)}/register`);
  await page.getByPlaceholder("username").fill(username);
  await page.getByPlaceholder("display name (optional)").fill(displayName);
  await page.getByPlaceholder("password").fill(PASSWORD);
  await page.getByRole("button", { name: /create|register|sign up/i }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  return { side, username, displayName, identity: `@${username}:${domainOf(side)}`, context, page };
}

/** Everyone gets a fresh browser, so closing them all (a test's `finally`, or its afterEach) leaves nothing behind. */
export async function closeAll(people: Person[]): Promise<void> {
  await Promise.all(people.map((p) => p.context.close()));
}

/** Sends a friend request from `from` to `to` (a username on the same server, or `@name:domain` for another) and has `to` accept it. */
export async function befriend(from: Person, to: Person): Promise<void> {
  const target = from.side === to.side ? to.username : to.identity;
  await goToFriends(from.page);
  await from.page.getByRole("combobox").fill(target);
  await from.page.getByRole("button", { name: "Send request" }).click();
  await expect(from.page.getByText(/Friend request sent to/)).toBeVisible();

  await goToFriends(to.page);
  await to.page.getByRole("tab", { name: /Incoming/ }).click();
  await expect(to.page.getByText(from.identity)).toBeVisible();
  await to.page.getByRole("button", { name: "Accept" }).click();

  await to.page.getByRole("tab", { name: /^Friends/ }).click();
  await expect(to.page.getByText(from.identity)).toBeVisible();
}

export async function goToFriends(page: Page): Promise<void> {
  await page.getByRole("link", { name: /Friends & DMs/ }).click();
  await expect(page.getByRole("tab", { name: /^Friends/ })).toBeVisible();
}

/** Opens (starting it if need be) the direct conversation with a friend, from the friends list. */
export async function openDm(me: Person, friend: Person): Promise<void> {
  await goToFriends(me.page);
  await me.page.getByRole("tab", { name: /^Friends/ }).click();
  const row = me.page.locator(".friend-request-row").filter({ hasText: friend.displayName });
  await row.getByRole("button", { name: "Message" }).click();
  await expect(me.page.getByPlaceholder(`Message ${friend.displayName}`)).toBeVisible();
}

/** Types into the open conversation or channel's composer and sends. */
export async function send(page: Page, placeholder: string, text: string): Promise<void> {
  await page.getByPlaceholder(placeholder).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

/** The message with this text, in whatever conversation or channel is open. */
export const messageWith = (page: Page, text: string) => page.locator(".message-row").filter({ hasText: text });

/** Message actions (edit, delete, react) only show while the pointer is over the message. */
export async function messageAction(page: Page, text: string, label: "Edit message" | "Delete message") {
  const row = messageWith(page, text);
  await row.hover();
  await row.getByRole("button", { name: label }).click();
}

/** Creates a community from the rail's "+" and returns its id (the one in its address, which is also its join code on its own server). */
export async function createCommunity(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Create a community" }).click();
  await page.getByPlaceholder("Community name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/communities\/[^/]+/);
  return new URL(page.url()).pathname.split("/")[2];
}

/** Joins a community from "Join by ID". `reference` is the bare id on the same server, `id:domain` for one on another. */
export async function joinCommunity(page: Page, name: string, reference: string): Promise<void> {
  await page.getByRole("button", { name: "Create a community" }).click();
  await page.getByRole("tab", { name: "Join by ID" }).click();
  await page.getByPlaceholder(/Invite code/).fill(reference);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name })).toBeVisible();
}

/** Opens a community's first channel from the rail. */
export async function openCommunity(page: Page, name: string): Promise<void> {
  await page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name }).click();
  await expect(page).toHaveURL(/\/communities\//);
}
