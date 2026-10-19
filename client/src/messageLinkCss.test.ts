import { describe, expect, it } from "vitest";
import css from "./index.css?raw";

// jsdom computes no styles, so these pin the two rules a link in a message depends on (#197).
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} is missing`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("addresses in messages", () => {
  it("wrap instead of widening the message", () => {
    expect(block(".message-text")).toMatch(/overflow-wrap: anywhere/);
  });

  it("use the link colour that the contrast test checks on the page backgrounds, and are underlined", () => {
    const link = block(".message-link");
    expect(link).toMatch(/color: var\(--accent-hover\)/);
    expect(link).toMatch(/text-decoration: underline/);
  });

  it("show where the keyboard is", () => {
    expect(css).toMatch(/\.message-link:focus-visible\s*\{[^}]*outline: 2px solid var\(--focus-ring\)/);
  });
});
