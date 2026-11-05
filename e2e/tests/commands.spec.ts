import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { SIDES } from "../support/stack.mjs";
import { accessTokenOf, closeAll, createCommunity, domainOf, joinCommunity, messageWith, openCommunity, signUp, uniqueName } from "../support/app";

// Slash commands (#132, phase 3b), end to end with the repository's example bot (it registers /ping, /echo and /slow): a member types "/", picks a command,
// fills in its form and sends it; the bot's public answer is an ordinary message under a "used /echo" line; a deferred, private answer is shown only to the
// person who ran it, first as "thinking"; a bot that has gone is refused at once and the form says so; and a member on ANOTHER server sees the bot's answer
// without that line and is offered no commands (they cannot run them yet).

const EXAMPLE = fileURLToPath(new URL("../../examples/echo-bot/bot.mjs", import.meta.url));
const api = `http://localhost:${SIDES.a.serverPort}/api/v1`;

function startBot(token: string): { process: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, [EXAMPLE], {
    env: { ...process.env, CHAT_URL: `http://localhost:${SIDES.a.serverPort}`, BOT_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let printed = "";
  child.stdout?.on("data", (chunk) => (printed += chunk));
  child.stderr?.on("data", (chunk) => (printed += chunk));
  return { process: child, output: () => printed };
}

test("a member runs the example bot's commands from the message box, and sees each kind of answer", async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await signUp(browser, "a", "olive");
  const guest = await signUp(browser, "b", "gus");
  const communityName = uniqueName("Commands Club").replace(/_/g, " ");
  const botName = `bot_${randomBytes(3).toString("hex")}`;
  let bot = null as ReturnType<typeof startBot> | null;
  try {
    const communityId = await createCommunity(owner.page, communityName);
    const mine = { Authorization: `Bearer ${await accessTokenOf(owner.page)}` };
    const made = await owner.page.request.post(`${api}/bots`, { headers: mine, data: { username: botName } });
    expect(made.status()).toBe(201);
    const { token } = await made.json();
    expect((await owner.page.request.post(`${api}/communities/${communityId}/bots`, { headers: mine, data: { username: botName } })).status()).toBe(201);
    await joinCommunity(guest.page, communityName, `${communityId}:${domainOf("a")}`);
    await openCommunity(guest.page, communityName);

    bot = startBot(token);
    await expect.poll(() => bot!.output(), { timeout: 30_000 }).toContain("Registered 3 slash commands.");
    await expect.poll(() => bot!.output(), { timeout: 30_000 }).toContain("Connected: listening for messages.");

    const box = owner.page.getByPlaceholder("Message #general");

    // The commands are offered as soon as "/" is typed, each with its bot; the list narrows as more is typed.
    await box.fill("/");
    const suggestions = owner.page.getByRole("listbox", { name: "Command suggestions" });
    await expect(suggestions.getByRole("option")).toHaveCount(3);
    await expect(suggestions).toContainText(botName);
    await box.fill("/ec");
    await expect(suggestions.getByRole("option")).toHaveCount(1);

    // /echo: pick it, fill in the one option, send. The answer is a message from the bot with a line saying who used which command.
    await box.press("Enter");
    const form = owner.page.getByRole("form", { name: "Run /echo" });
    await expect(form).toBeVisible();
    await expect(box).toHaveValue(""); // what was typed was only the search
    await expect(form.getByRole("button", { name: "Send" })).toBeDisabled(); // the text is required
    await form.getByLabel(/^text/).fill("hello from a form");
    await form.getByRole("button", { name: "Send" }).click();
    await expect(form).toHaveCount(0);
    const answer = messageWith(owner.page, "hello from a form");
    await expect(answer).toBeVisible();
    await expect(answer.locator(".message-interaction")).toContainText("used /echo");
    await expect(answer).toContainText("Bot");
    await expect(owner.page.getByText(/^Waiting for /)).toHaveCount(0); // the answer cleared the notice

    // A person on the other server sees the answer, without the "used" line (nothing is relayed to say which command caused it), and no command list.
    const there = messageWith(guest.page, "hello from a form");
    await expect(there).toBeVisible();
    await expect(there.locator(".message-interaction")).toHaveCount(0);
    await guest.page.getByPlaceholder("Message #general").fill("/");
    await expect(guest.page.getByRole("listbox", { name: "Command suggestions" })).toHaveCount(0);

    // /slow: the bot says it is thinking and answers only the person who asked. Nobody else gets it, and nothing is put in the channel.
    await box.fill("/slow");
    await box.press("Enter");
    await owner.page.getByRole("form", { name: "Run /slow" }).getByRole("button", { name: "Send" }).click();
    const private_ = owner.page.getByRole("region", { name: "Replies to your commands" });
    await expect(private_.getByText("That took a moment. Only you can see this.")).toBeVisible({ timeout: 15_000 });
    await expect(private_).toContainText("Only you can see this ·");
    await expect(messageWith(owner.page, "That took a moment")).toHaveCount(0);
    await expect(messageWith(guest.page, "That took a moment")).toHaveCount(0);
    await private_.getByRole("button", { name: "Dismiss the reply to /slow" }).click();
    await expect(private_).toHaveCount(0);

    // The bot goes away: the server refuses at once, and the form says why and stays open to try again later.
    bot.process.kill();
    await expect.poll(() => bot!.process.killed || bot!.process.exitCode !== null).toBeTruthy();
    await box.fill("/ping");
    await box.press("Enter");
    const pingForm = owner.page.getByRole("form", { name: "Run /ping" });
    await pingForm.getByRole("button", { name: "Send" }).click();
    await expect(pingForm.getByRole("alert")).toContainText(`${botName} is offline right now.`, { timeout: 20_000 });
    await pingForm.getByRole("button", { name: "Cancel" }).click();
    await expect(pingForm).toHaveCount(0);
  } finally {
    bot?.process.kill();
    await closeAll([owner, guest]);
  }
});
