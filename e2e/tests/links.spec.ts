import { expect, test } from "@playwright/test";
import { befriend, clientUrl, closeAll, messageWith, openDm, send, signUp } from "../support/app";

// Addresses in a message are links (#197), on both servers, and opening one cannot reach back into the page that did.
test("an address in a message is a link on both servers, opens in a new tab and cannot reach back", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await befriend(alice, bella);
    await openDm(alice, bella);
    await openDm(bella, alice);

    const target = `${clientUrl("b")}/login`;
    await send(alice.page, "Message Bella", `look at ${target}, thanks. javascript:alert(1)`);

    for (const person of [alice, bella]) {
      const row = messageWith(person.page, "look at");
      const link = row.getByRole("link", { name: target });
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute("href", target);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/);
      // The full stop after it is not part of the link, and the other scheme is not a link at all.
      await expect(row).toContainText(`${target}, thanks. javascript:alert(1)`);
      // (Scoped to the text: the servers here also make link previews, whose card has a link of its own.)
      await expect(row.locator(".message-text").getByRole("link")).toHaveCount(1);
    }

    // Opening it: a new tab at that address, with no way back to the page that opened it.
    const link = messageWith(bella.page, "look at").getByRole("link", { name: target });
    const [popup] = await Promise.all([bella.context.waitForEvent("page"), link.click()]);
    await popup.waitForLoadState();
    expect(popup.url()).toBe(target);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await popup.close();
    // The message page is still where it was.
    await expect(messageWith(bella.page, "look at")).toHaveCount(1);
  } finally {
    await closeAll([alice, bella]);
  }
});
