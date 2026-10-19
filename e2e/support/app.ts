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

/** The community header's own Settings button (the account footer has one too). */
const openCommunitySettings = (owner: Person) => owner.page.locator("main").getByRole("button", { name: "Settings", exact: true }).click();

export async function chooseWhoCanJoin(owner: Person, choice: RegExp) {
  await openCommunitySettings(owner);
  // The choice shows at once, before it is saved, so wait for the save itself: a reload straight away would cancel it.
  const saved = owner.page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/api/v1/communities/") && r.ok());
  await owner.page.getByRole("radio", { name: choice }).check();
  await saved;
  // The server has it before anyone relies on it: close the dialog, reload, and look again.
  await owner.page.keyboard.press("Escape");
  await owner.page.reload();
  await openCommunitySettings(owner);
  await expect(owner.page.getByRole("radio", { name: choice })).toBeChecked();
  await owner.page.keyboard.press("Escape");
}

// A 1x1 PNG: all an emoticon needs to be a picture.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHx3PzAAAAABJRU5ErkJggg==", "base64");

/** Makes a personal emoticon on the Emoticons page (by address, since a community's sidebar has no link to it) and returns to where it was. */
export async function createEmoticon(person: Person, name: string, trigger: string): Promise<void> {
  const page = person.page;
  const back = page.url();
  await page.goto(`${clientUrl(person.side)}/emoticons`);
  await page.locator('input[type="file"]').setInputFiles({ name: "e.png", mimeType: "image/png", buffer: PNG });
  await page.getByPlaceholder("Emoticon name").fill(name);
  await page.getByPlaceholder(":trigger:").fill(trigger);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText(trigger, { exact: true })).toBeVisible();
  await page.goto(back);
}

/** What the page has been asked to play and show since it loaded (see `watchAlerts`). */
export interface Alerts {
  sounds: number;
  notifications: { title: string; body: string }[];
}

/**
 * Stands in for the browser's audio engine and Notification API (neither can be heard or seen from a test), recording what the app
 * asks of them, and reloads the page so it is in place from the start. The app plays a sound by starting two oscillators (two
 * notes), so a sound is two starts. `document.hasFocus()` answers what `setFocused` last said (true to begin with).
 */
export async function watchAlerts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const record = { oscillators: 0, notifications: [] as { title: string; body: string }[] };
    w.__alerts = record;
    w.__focused = true;
    document.hasFocus = () => w.__focused as boolean;
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      resume = async () => {};
      createGain() {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n: unknown) => n };
      }
      createOscillator() {
        return {
          type: "",
          frequency: { value: 0 },
          connect: (n: unknown) => n,
          start() {
            record.oscillators += 1;
          },
          stop() {},
        };
      }
    }
    w.AudioContext = FakeAudioContext;
    class FakeNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      close() {}
      constructor(title: string, options?: { body?: string }) {
        record.notifications.push({ title, body: options?.body ?? "" });
      }
    }
    w.Notification = FakeNotification;
  });
  await page.reload();
}

export const alertsOf = async (page: Page): Promise<Alerts> => {
  const record = await page.evaluate(() => (window as unknown as { __alerts: { oscillators: number; notifications: Alerts["notifications"] } }).__alerts);
  return { sounds: record.oscillators / 2, notifications: record.notifications };
};

/** Tells the app whether its window has focus (what `document.hasFocus()` answers). */
export const setFocused = (page: Page, focused: boolean): Promise<void> =>
  page.evaluate((value) => void ((window as unknown as { __focused: boolean }).__focused = value), focused);
