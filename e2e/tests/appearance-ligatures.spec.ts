import { expect, test } from "@playwright/test";
import { closeAll, signUp } from "../support/app";

// The Ligatures option has to change what is drawn. Unit tests only see CSS values, so a font that does not draw
// ligatures (the system monospace was Cascadia Mono) looked fine to them while the checkbox did nothing (#208). This draws
// the preview both ways in a real browser and compares the pictures.

test("the Ligatures option changes the preview wherever it is offered, and is not offered where it could not", async ({ browser }) => {
  const person = await signUp(browser, "a", "ligatures");
  try {
    const page = person.page;
    await page.getByTitle("Settings", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
    const preview = page.locator(".font-preview");
    const box = page.getByLabel(/^Ligatures/);

    // The bundled coding fonts draw them: the option must be there, and ticking it must change the picture.
    for (const [value, family] of [["jetbrains-mono", "JetBrains Mono"], ["fira-code", "Fira Code"]] as const) {
      await page.getByLabel("Font", { exact: true }).selectOption(value);
      await page.evaluate((f) => document.fonts.load(`16px "${f}"`), family);
      await expect(box, value).toBeVisible();
      if (await box.isChecked()) await box.uncheck();
      const off = await preview.screenshot();
      await box.check();
      const on = await preview.screenshot();
      expect(on.equals(off), `${value}: ticking Ligatures changed nothing`).toBe(false);
      await box.uncheck();
    }

    // IBM Plex Mono has none: no checkbox, and it says why.
    await page.getByLabel("Font", { exact: true }).selectOption("ibm-plex-mono");
    await expect(box).toHaveCount(0);
    await expect(page.getByText("This font does not draw ligatures, so there is nothing to turn on.")).toBeVisible();

    // The system monospace depends on the machine (Cascadia Code on Windows, none on most Linux): whatever it is, an option
    // that is offered has to do something, and one that would not is not offered.
    await page.getByLabel("Font", { exact: true }).selectOption("mono-system");
    if ((await box.count()) > 0) {
      if (await box.isChecked()) await box.uncheck();
      const off = await preview.screenshot();
      await box.check();
      const on = await preview.screenshot();
      expect(on.equals(off), "Monospace (system): the option is offered but changes nothing").toBe(false);
    } else {
      await expect(page.getByText("This font does not draw ligatures, so there is nothing to turn on.")).toBeVisible();
    }
  } finally {
    await closeAll([person]);
  }
});
