import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { SIDES } from "../support/stack.mjs";
import { accessTokenOf, clientUrl, closeAll, createCommunity, domainOf, joinCommunity, messageWith, openCommunity, send, signUp, uniqueName } from "../support/app";

// Bot accounts (#132), end to end: a person makes a bot in Settings -> Developer and gets its token once, a community's manager adds it, the
// repository's own example bot (examples/echo-bot, started exactly as its README says) is run against the real server and answers a message in
// a real browser with a Bot badge beside its name, and replacing the token ends the running bot at once. The contract in docs/bots.md is
// exercised for real, by a program that only knows that document.

const EXAMPLE = fileURLToPath(new URL("../../examples/echo-bot/bot.mjs", import.meta.url));

/** A running copy of the example bot, with what it has printed so far. */
function startBot(token: string): { process: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [EXAMPLE], {
    env: { ...process.env, CHAT_URL: `http://localhost:${SIDES.a.serverPort}`, BOT_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let printed = "";
  child.stdout?.on("data", (chunk) => (printed += chunk));
  child.stderr?.on("data", (chunk) => (printed += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { process: child, output: () => printed, exited };
}

test("a bot is made, added by a manager, answers in the app with a Bot badge, and is ended by replacing its token", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await signUp(browser, "a", "olive");
  const communityName = uniqueName("Bots Club").replace(/_/g, " ");
  const botName = `bot_${randomBytes(3).toString("hex")}`;
  // Cast: it is set inside a step (a closure), which TypeScript does not follow, so without it the finally block sees only `null`.
  let bot = null as ReturnType<typeof startBot> | null;
  try {
    const { page } = owner;
    let token = "";

    await test.step("Settings -> Developer makes a bot and shows its token once", async () => {
      await page.getByTitle("Settings", { exact: true }).click();
      await expect(page.getByRole("heading", { name: "Developer" })).toBeVisible();
      await page.getByLabel("Bot name").fill(botName);
      await page.getByRole("button", { name: "Make a bot" }).click();
      const shown = page.getByLabel(/^Token for/);
      await expect(shown).toBeVisible();
      token = (await shown.textContent()) ?? "";
      expect(token).toMatch(/^mcb_[A-Za-z0-9_-]{43}$/);
      await expect(page.getByRole("list", { name: "Your bots" })).toContainText(`@${botName}:`);

      // Once dismissed it is gone for good, and a reload does not bring it back.
      await page.getByRole("button", { name: "I have saved it" }).click();
      await page.reload();
      await expect(page.getByRole("list", { name: "Your bots" })).toBeVisible();
      await expect(page.getByText(token)).toHaveCount(0);
    });

    await test.step("the community's manager adds it by name, and it is in the member list marked as a bot", async () => {
      await page.goto(clientUrl("a"));
      await createCommunity(page, communityName);
      await page.locator("main").getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("Add a bot", { exact: true }).fill(botName);
      await page.getByRole("button", { name: "Add bot" }).click();
      await expect(page.getByText(/was added\./)).toBeVisible();
      await page.getByRole("tab", { name: /Members/ }).click();
      const row = page.locator(".friend-request-row").filter({ hasText: `@${botName}:` });
      await expect(row).toContainText("Bot");
      await page.getByRole("button", { name: "Close" }).click();
    });

    await test.step("the example bot connects with its token and answers a message, marked as a bot", async () => {
      bot = startBot(token);
      await expect.poll(() => bot!.output(), { timeout: 30_000 }).toContain("Connected: listening for messages.");
      await send(page, "Message #general", "!ping");
      const reply = messageWith(page, "pong");
      await expect(reply).toBeVisible();
      await expect(reply).toContainText("Bot");
    });

    await test.step("a new token ends the running bot at once, and the old token no longer works", async () => {
      await page.getByTitle("Settings", { exact: true }).click();
      await page.getByRole("button", { name: `New token for ${botName}` }).click();
      await expect(page.getByLabel(/^Token for/)).toBeVisible();
      expect(await bot!.exited).toBe(1);
      expect(bot!.output()).toContain("refused the token");

      const refused = await page.request.get(`http://localhost:${SIDES.a.serverPort}/api/v1/users/me`, { headers: { Authorization: `Bot ${token}` } });
      expect(refused.status()).toBe(401);
    });
  } finally {
    bot?.process.kill();
    await closeAll([owner]);
  }
});

test("a person on another server sees the bot's messages marked as a bot", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await signUp(browser, "a", "olive");
  const guest = await signUp(browser, "b", "gus");
  const communityName = uniqueName("Far Bots").replace(/_/g, " ");
  const botName = `bot_${randomBytes(3).toString("hex")}`;
  const api = `http://localhost:${SIDES.a.serverPort}/api/v1`;
  let bot = null as ReturnType<typeof startBot> | null;
  try {
    const communityId = await createCommunity(owner.page, communityName);
    // The bot is made and added through the API (the screens are covered by the test above): what is under test is the other server.
    const mine = { Authorization: `Bearer ${await accessTokenOf(owner.page)}` };
    const made = await owner.page.request.post(`${api}/bots`, { headers: mine, data: { username: botName } });
    expect(made.status()).toBe(201);
    const { token } = await made.json();
    const added = await owner.page.request.post(`${api}/communities/${communityId}/bots`, { headers: mine, data: { username: botName } });
    expect(added.status()).toBe(201);

    await joinCommunity(guest.page, communityName, `${communityId}:${domainOf("a")}`);
    await openCommunity(guest.page, communityName);

    bot = startBot(token);
    await expect.poll(() => bot!.output(), { timeout: 30_000 }).toContain("Connected: listening for messages.");
    await send(guest.page, "Message #general", "!ping");
    // The guest's own server never heard of this bot until the home server relayed its message, and it says what the bot is.
    const reply = messageWith(guest.page, "pong");
    await expect(reply).toBeVisible();
    await expect(reply).toContainText("Bot");
    await expect(messageWith(guest.page, "!ping")).not.toContainText("Bot");
  } finally {
    bot?.process.kill();
    await closeAll([owner, guest]);
  }
});
