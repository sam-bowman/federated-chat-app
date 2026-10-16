import { expect, test } from "@playwright/test";
import { befriend, closeAll, createEmoticon, messageWith, openDm, send, signUp } from "../support/app";

// A custom emoticon's trigger means different things to different people, so a reaction names the emoticon itself and
// carries its picture. Across two real servers that picture has to be an address the OTHER server can fetch.
test("a custom emoticon reaction is the picture for everyone, including a person on another server", async ({ browser }) => {
  const alice = await signUp(browser, "a", "alice");
  const bella = await signUp(browser, "b", "bella");
  try {
    await befriend(alice, bella);
    await openDm(alice, bella);
    await openDm(bella, alice);
    await createEmoticon(alice, "Party", ":party:");
    await send(alice.page, "Message Bella", "react to this");
    await expect(messageWith(bella.page, "react to this")).toHaveCount(1);

    // Alice reacts from the "+" picker, from her own emoticons.
    const row = messageWith(alice.page, "react to this");
    await row.hover();
    await row.getByRole("button", { name: "More reactions" }).click();
    await alice.page.getByRole("region", { name: "Your emoticons" }).getByRole("button", { name: "Party :party:" }).click();

    // Both see a pill named Party with a picture that actually loaded. Bella has no such emoticon: the picture comes from Alice's server.
    for (const person of [alice, bella]) {
      const pill = messageWith(person.page, "react to this").getByRole("button", { name: "Party 1" });
      await expect(pill).toBeVisible();
      const image = pill.locator("img");
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    }
    const src = await messageWith(bella.page, "react to this").getByRole("button", { name: "Party 1" }).locator("img").getAttribute("src");
    expect(src).toMatch(/^https?:\/\/.+\/uploads\//);

    // It was saved, not just shown: still there after a reload.
    await bella.page.reload();
    await expect(messageWith(bella.page, "react to this").getByRole("button", { name: "Party 1" })).toBeVisible();

    // Bella cannot add an emoticon she cannot use, and is told so, and nothing changes.
    await messageWith(bella.page, "react to this").getByRole("button", { name: "Party 1" }).click();
    await expect(bella.page.getByRole("alert")).toHaveText("You can't use that emoticon.");

    // Alice takes hers back: it goes from both.
    await messageWith(alice.page, "react to this").getByRole("button", { name: "Party 1" }).click();
    await expect(messageWith(alice.page, "react to this").locator(".reaction-pill")).toHaveCount(0);
    await expect(messageWith(bella.page, "react to this").locator(".reaction-pill")).toHaveCount(0);
  } finally {
    await closeAll([alice, bella]);
  }
});
