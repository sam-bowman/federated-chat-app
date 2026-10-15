import { describe, expect, it } from "vitest";
import css from "./index.css?raw";

// jsdom does not compute styles, so a CSS ordering bug cannot be seen by rendering. This one was seen in a
// real browser: a community tile with its own colour turned the accent blue when selected, because
// `.rail-tile-coloured.active` has the same specificity as the later `.rail-item.active` rule, which wins on
// order. The coloured rules must be more specific than the hover and selected ones they override.
describe("coloured community tiles", () => {
  const rule = (selector: string) => css.indexOf(`${selector} {`) !== -1 || css.indexOf(`${selector},`) !== -1;

  it("override the accent colour on hover and when selected, with a selector that outranks .rail-item.active", () => {
    expect(rule(".rail-item.rail-tile-coloured.active")).toBe(true);
    expect(rule(".rail-item.rail-tile-coloured:hover")).toBe(true);
  });

  it("use the colours passed as custom properties", () => {
    const block = css.slice(css.indexOf(".rail-item.rail-tile-coloured,"));
    expect(block.slice(0, block.indexOf("}"))).toContain("background: var(--tile-bg)");
    expect(block.slice(0, block.indexOf("}"))).toContain("color: var(--tile-fg)");
  });

  it("do not rely on a plain .rail-tile-coloured selector, which loses to .rail-item.active", () => {
    expect(css).not.toMatch(/(^|\n)\.rail-tile-coloured/);
  });
});
