import { expect, test } from "@playwright/test";
import { closeAll, createCommunity, messageWith, openCommunity, signUp } from "../support/app";
import { SIDES } from "../support/stack.mjs";

// Moving between communities (#237), in a real browser with a slow network, since the problem only shows while a channel's messages are on their way:
// the page is not rebuilt when only the channel changes, and it used to leave the old channel's messages on screen, under the new channel's name,
// until the new ones arrived. Checked by looking at the page every few milliseconds rather than at one moment.

test("moving between communities never shows one community's messages under another's name, nor 'No messages yet' for one that has some", async ({ browser }) => {
  test.setTimeout(120_000);
  const me = await signUp(browser, "a", "switcher");
  const { page } = me;
  try {
    const names = ["Alpha", "Bravo"];
    const api = `http://localhost:${SIDES.a.serverPort}/api/v1`;
    for (const name of names) {
      await createCommunity(page, name);
      // The id from the rail's link: the address can still be the previous community's for a moment.
      const rail = page.getByRole("navigation", { name: "Communities" }).getByRole("link", { name, exact: true });
      await expect(rail).toBeVisible();
      const id = (await rail.getAttribute("href"))!.split("/")[2];
      const headers = { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem("chat.accessToken"))}` };
      const community = (await (await page.request.get(`${api}/communities/${id}`, { headers })).json()).community;
      for (let i = 1; i <= 5; i++) {
        const res = await page.request.post(`${api}/channels/${community.channels[0].id}/messages`, { headers, data: { content: `${name} message ${i}` } });
        expect(res.status()).toBe(201);
      }
    }
    await page.reload();
    await expect(messageWith(page, "Bravo message 5")).toBeVisible();

    // A slow network, so each channel's messages are on their way for a good while.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 250, downloadThroughput: (2 * 1024 * 1024) / 8, uploadThroughput: (1 * 1024 * 1024) / 8 });

    // Look every 10 ms, and keep what was on screen each time.
    await page.evaluate(() => {
      const w = window as unknown as { __seen: { header: string; list: string; busy: boolean }[]; __timer: number };
      w.__seen = [];
      w.__timer = window.setInterval(() => {
        w.__seen.push({
          header: document.querySelector("main .main-header-title")?.textContent ?? "",
          list: document.querySelector(".message-list")?.textContent ?? "",
          busy: document.querySelector(".message-list")?.getAttribute("aria-busy") === "true",
        });
      }, 10);
    });

    for (const name of [...names, ...names, ...names]) {
      await openCommunity(page, name);
      await expect(messageWith(page, `${name} message 5`)).toBeVisible();
    }

    const seen = await page.evaluate(() => {
      const w = window as unknown as { __seen: { header: string; list: string; busy: boolean }[]; __timer: number };
      window.clearInterval(w.__timer);
      return w.__seen;
    });
    expect(seen.length).toBeGreaterThan(50);

    const wrong = seen.filter(
      (s) =>
        (s.header.includes("Alpha") && s.list.includes("Bravo message")) ||
        (s.header.includes("Bravo") && s.list.includes("Alpha message")) ||
        s.list.includes("No messages yet")
    );
    expect(wrong, `the page showed ${wrong.length} wrong moments, the first: ${JSON.stringify(wrong[0])}`).toEqual([]);
    // The look-in-between really happened: there were moments with the new channel's name up and its messages still on their way.
    expect(seen.some((s) => s.busy)).toBe(true);
  } finally {
    await closeAll([me]);
  }
});
