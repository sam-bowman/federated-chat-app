import { expect, test, type Page } from "@playwright/test";
import { clientUrl, closeAll, createCommunity, messageWith, openCommunity, signUp } from "../support/app";

// A 1x1 transparent PNG: all an emoticon needs to be a picture.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHx3PzAAAAABJRU5ErkJggg==", "base64");

async function makeEmoticon(page: Page, name: string, trigger: string) {
  // The sidebar inside a community lists channels, not the Emoticons link: go by address (the session is kept).
  await page.goto(`${clientUrl("a")}/emoticons`);
  await page.locator('input[type="file"]').setInputFiles({ name: "e.png", mimeType: "image/png", buffer: PNG });
  await page.getByPlaceholder("Emoticon name").fill(name);
  await page.getByPlaceholder(":trigger:").fill(trigger);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText(trigger, { exact: true })).toBeVisible();
}

test("emoticons go in at the cursor from the picker, and complete as ':' is typed", async ({ browser }) => {
  const ann = await signUp(browser, "a", "ann");
  try {
    await createCommunity(ann.page, "Composer Club");
    await makeEmoticon(ann.page, "Party", ":party:");
    await makeEmoticon(ann.page, "Parade", ":parade:");
    await openCommunity(ann.page, "Composer Club");
    const box = ann.page.getByPlaceholder("Message #general");
    await expect(box).toBeVisible();

    // The picker puts it where the caret is, replaces a selection, and leaves the caret after it.
    await box.fill("hello world");
    await box.press("Home");
    for (let i = 0; i < 5; i++) await box.press("ArrowRight");
    await ann.page.getByRole("button", { name: "Emoji and emoticons" }).click();
    await ann.page.getByRole("button", { name: "Party :party:" }).click();
    await expect(box).toHaveValue("hello :party: world");
    await expect(box).toBeFocused();
    await box.pressSequentially("X");
    await expect(box).toHaveValue("hello :party: Xworld");

    // Holding Shift keeps the picker open for the next pick, which lands right after the first.
    await box.fill("");
    await ann.page.getByRole("button", { name: "Emoji and emoticons" }).click();
    // (Used ones are also listed under "Recently used", so pick from the emoticons' own section.)
    const mine = ann.page.getByRole("region", { name: "Your emoticons" });
    await mine.getByRole("button", { name: "Party :party:" }).click({ modifiers: ["Shift"] });
    await mine.getByRole("button", { name: "Parade :parade:" }).click();
    await expect(box).toHaveValue(":party: :parade: ");
    await expect(ann.page.getByRole("dialog", { name: "Emoji picker" })).toHaveCount(0);

    // Typing ":pa" suggests; arrows move, Enter completes (and does not send); Escape dismisses.
    await box.fill("");
    await box.pressSequentially("see :pa");
    await expect(ann.page.getByRole("option")).toHaveCount(2);
    await box.press("Escape");
    await expect(ann.page.getByRole("listbox")).toHaveCount(0);
    await box.pressSequentially("r");
    await expect(ann.page.getByRole("option")).toHaveCount(2);
    await box.press("ArrowDown");
    await box.press("Enter");
    await expect(box).toHaveValue("see :parade: ");
    await expect(messageWith(ann.page, "see")).toHaveCount(0);

    // Sent, it shows as the picture.
    await box.press("Enter");
    await expect(messageWith(ann.page, "").locator('img[alt=":parade:"]')).toHaveCount(1);
  } finally {
    await closeAll([ann]);
  }
});
