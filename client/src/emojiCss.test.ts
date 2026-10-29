// jsdom computes no layout, so what the stylesheet says about emoji and emoticon sizes (#285) is pinned here, the way modalCss and tileCss do.
import { describe, expect, it } from "vitest";
import rawCss from "./index.css?raw";

const css = rawCss.replace(/\r\n/g, "\n");
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
};

describe("emoji and emoticon sizes", () => {
  it("are set by custom properties, large by default", () => {
    const root = css.slice(css.indexOf("--emoji-inline: 1.75rem"), css.indexOf(':root[data-emoji-size="normal"]'));
    expect(root).toContain("--emoji-inline: 1.75rem");
    expect(root).toContain("--emoji-big: 3rem");
  });

  it("go back to the old sizes for Normal, for every property that Large changes", () => {
    const normal = rule(':root[data-emoji-size="normal"]');
    // The sizes before #285: an emoticon 1.375rem tall, a Unicode emoji the size of the text, a custom reaction 1.125rem.
    expect(normal).toContain("--emoji-inline: 1.375rem");
    expect(normal).toContain("--emoji-text: 1em");
    expect(normal).toContain("--emoji-big: 1.375rem");
    expect(normal).toContain("--emoji-big-text: 1em");
    expect(normal).toContain("--reaction-emoji: 1em");
    expect(normal).toContain("--reaction-emoticon: 1.125rem");

    const large = css.slice(css.indexOf("--emoji-inline: 1.75rem"), css.indexOf(':root[data-emoji-size="normal"]'));
    const properties = large.match(/--[a-z-]+(?=:)/g) ?? [];
    expect(properties.length).toBe(6);
    for (const property of properties) {
      expect(normal, `${property} must be set for Normal too`).toContain(property);
    }
  });

  it("are used by the things that draw them, and nothing draws them with a fixed size", () => {
    expect(rule(".emoticon-image")).toContain("height: var(--emoji-inline)");
    expect(rule(".emoji")).toContain("font-size: var(--emoji-text)");
    expect(rule(".emoji")).toContain("line-height: 1");
    expect(rule(".message-jumbo .emoticon-image")).toContain("height: var(--emoji-big)");
    expect(rule(".message-jumbo .emoji")).toContain("font-size: var(--emoji-big-text)");
    expect(rule(".reaction-pill .emoticon-thumb")).toContain("var(--reaction-emoticon)");
    expect(rule(".reaction-emoji")).toContain("font-size: var(--reaction-emoji)");
  });
});
