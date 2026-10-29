import { expect, test, type Locator, type Page } from "@playwright/test";
import { closeAll, createCommunity, createEmoticon, messageWith, send, signUp } from "../support/app";

// Emoji and custom emoticons used to be drawn at the size of the text, or a little over (#285). jsdom computes no layout, so what a person
// SEES is measured here: the size an emoji is really drawn at, in a real browser, for the three kinds of message and for each setting.

const sizeOf = (page: Page, text: string, selector: string) =>
  messageWith(page, text)
    .locator(selector)
    .first()
    .evaluate((el) => (el.tagName === "IMG" ? el.getBoundingClientRect().height : Number.parseFloat(getComputedStyle(el).fontSize)));

/** A message of only an emoticon has no text to find it by: it is the one whose emoticon sits in the large wrapper. */
const bigEmoticon = (page: Page) => page.locator(".message-jumbo img.emoticon-image").first();
const heightOf = (image: Locator) => image.evaluate((img) => img.getBoundingClientRect().height);

const textSize = (page: Page, text: string) =>
  messageWith(page, text)
    .locator(".message-text")
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));

/** Sends a message and waits for it to appear: the composer clears itself when the send finishes, which would wipe the next one typed too soon. */
async function post(page: Page, text: string) {
  const rows = page.locator(".message-row");
  const before = await rows.count();
  await send(page, "Message #general", text);
  await expect(rows).toHaveCount(before + 1);
}

async function chooseEmojiSize(page: Page, label: "Large" | "Normal") {
  await page.getByTitle("Settings", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  const group = page.getByRole("group", { name: "Emoji and emoticons in messages" });
  await group.getByRole("button", { name: label, exact: true }).click();
  await expect(group.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
}

test("emoji and emoticons are drawn larger in a sentence, much larger alone, and the setting puts the old size back", async ({ browser }) => {
  const person = await signUp(browser, "a", "emma");
  try {
    const page = person.page;
    await createEmoticon(person, "Party", ":party:");
    await createCommunity(page, `Emoji ${Date.now()}`);

    await post(page, "sentence with 😀 inside");
    await post(page, "🎉😀");
    await post(page, ":party:");
    await post(page, "words and :party: together");
    await post(page, "plain words only");

    const text = await textSize(page, "plain words only");

    // A Unicode emoji among words is larger than the words; alone it is much larger still.
    const inSentence = await sizeOf(page, "sentence with", ".emoji");
    const alone = await sizeOf(page, "🎉😀", ".emoji");
    expect(inSentence).toBeGreaterThan(text * 1.2);
    expect(alone).toBeGreaterThan(inSentence * 1.8);
    expect(alone).toBeGreaterThan(text * 2.5);

    // The same for a custom emoticon, measured by its picture; it has to have loaded for its height to count.
    const emoticonImages = page.locator(".message-row img.emoticon-image");
    await expect(emoticonImages).toHaveCount(2);
    await expect.poll(() => emoticonImages.first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const emoticonAlone = await heightOf(bigEmoticon(page));
    const emoticonInSentence = await sizeOf(page, "words and", "img.emoticon-image");
    expect(emoticonInSentence).toBeGreaterThan(text * 1.5);
    expect(emoticonAlone).toBeGreaterThan(emoticonInSentence * 1.5);

    // A line of words with no emoji is not touched: only the lines that hold one may be taller, and the plain one keeps the text's own height.
    const plainHeight = await messageWith(page, "plain words only").locator(".message-text").evaluate((el) => el.getBoundingClientRect().height);
    expect(plainHeight).toBeLessThan(text * 1.6);

    // Reactions are bigger too.
    const row = messageWith(page, "plain words only");
    await row.hover();
    await row.getByRole("button", { name: "React with 👍" }).click();
    const reaction = await row.locator(".reaction-emoji").first().evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(reaction).toBeGreaterThan(14);

    // "Normal" puts the old sizes back, at once, for what is already on the page.
    await chooseEmojiSize(page, "Normal");
    await expect.poll(() => sizeOf(page, "sentence with", ".emoji")).toBeCloseTo(text, 0);
    await expect.poll(() => sizeOf(page, "🎉😀", ".emoji")).toBeCloseTo(text, 0);
    await expect.poll(() => heightOf(bigEmoticon(page))).toBeCloseTo(22, 0);

    // ...and the choice is kept for the next visit.
    await page.reload();
    await expect.poll(() => heightOf(bigEmoticon(page))).toBeCloseTo(22, 0);
    await chooseEmojiSize(page, "Large");
    await expect.poll(() => heightOf(bigEmoticon(page))).toBeGreaterThan(40);
  } finally {
    await closeAll([person]);
  }
});

test("a large emoji still fits a phone-sized window without a sideways scroll", async ({ browser }) => {
  const person = await signUp(browser, "a", "mia", { viewport: { width: 375, height: 700 }, hasTouch: true, isMobile: true });
  try {
    const page = person.page;
    await createCommunity(page, `Phone ${Date.now()}`);
    await post(page, "😀😀😀😀😀😀😀😀😀😀");
    await expect(messageWith(page, "😀😀😀😀😀😀😀😀😀😀")).toHaveCount(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await closeAll([person]);
  }
});
