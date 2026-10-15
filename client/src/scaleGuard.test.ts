import { describe, expect, it } from "vitest";
import css from "./index.css?raw";

// The UI scale works by changing the root font size, so it only reaches lengths written in rem. A length written in px
// does not follow it: at 200% the text is twice the size and a px-sized box around it is not, which is how a control
// ends up clipped. These tests keep the stylesheet and the inline styles in rem. Hairlines (1px and 2px borders,
// outlines, shadows and dividers) are deliberately left thin and are allowed.

// Every file's raw text, to look for inline styles. Vite replaces globs at build time.
const sources = import.meta.glob("./**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// The one px that belongs: the root's base size, 16px times the scale.
const ROOT_SIZE = /font-size:\s*calc\(16px \* var\(--ui-scale, 1\)\);/;
// Newlines normalised: a Windows checkout has CRLF, CI has LF.
const withoutComments = css.replaceAll("\r\n", "\n").replace(/\/\*[\s\S]*?\*\//g, "");
const withoutRootSize = withoutComments.replace(ROOT_SIZE, "");

describe("the stylesheet is written in rem", () => {
  it("has no length over 2px in px", () => {
    const offenders = withoutRootSize
      .split(/\r?\n/)
      .map((text, i) => ({ text: text.trim(), line: i + 1 }))
      .filter(({ text }) => !text.startsWith("@media"))
      .filter(({ text }) => [...text.matchAll(/(-?\d*\.?\d+)px\b/g)].some((m) => Math.abs(parseFloat(m[1])) > 2));

    expect(offenders.map((o) => `${o.line}: ${o.text}`)).toEqual([]);
  });

  it("never sets a font size in px", () => {
    expect(withoutRootSize).not.toMatch(/font-size:[^;]*px/);
  });

  it("scales the root font size from --ui-scale, which index.html and lib/appearance.ts set", () => {
    expect(withoutComments).toMatch(/:root\s*\{[^}]*font-size:\s*calc\(16px \* var\(--ui-scale, 1\)\)/);
  });
});

describe("inline styles are written in rem", () => {
  const SIZED =
    "gap|rowGap|columnGap|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|margin|marginTop|marginBottom|marginLeft|marginRight|width|height|maxWidth|minWidth|maxHeight|minHeight|fontSize|borderRadius|flexBasis";
  // A number is px to React. 0 is fine, and so is a percentage string.
  const numeric = new RegExp(`\\b(${SIZED})\\s*:\\s*(?!0\\b)-?\\d+(\\.\\d+)?\\s*[,}\\n]`);
  const pxString = new RegExp(`\\b(${SIZED})\\s*:\\s*"[^"]*\\d\\s*px`);

  it("uses no bare number for a size, which would be px", () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.endsWith(".test.tsx"))
      .flatMap(([file, text]) =>
        text
          .split(/\r?\n/)
          .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
          .filter(({ text }) => !text.startsWith("//") && !text.startsWith("*") && numeric.test(text))
      );

    expect(offenders.map((o) => `${o.file}:${o.line}: ${o.text}`)).toEqual([]);
  });

  it("uses no px string for a size", () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.endsWith(".test.tsx"))
      .flatMap(([file, text]) =>
        text
          .split(/\r?\n/)
          .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
          .filter(({ text }) => pxString.test(text))
      );

    expect(offenders.map((o) => `${o.file}:${o.line}: ${o.text}`)).toEqual([]);
  });
});

describe("rules that keep the UI usable at a large UI scale", () => {
  // The text of the rule that starts at the beginning of a line with exactly this selector.
  const rule = (selector: string) => {
    const start = withoutComments.indexOf(`\n${selector} {`);
    expect(start, `${selector} has a rule`).not.toBe(-1);
    return withoutComments.slice(start, withoutComments.indexOf("}", start));
  };

  // A text box's own width is its default size; unless it may shrink, it pushes the buttons beside it out of a short row.
  it("lets a text box shrink in a flex row", () => {
    expect(rule("input,\ntextarea,\nselect")).toContain("min-width: 0");
  });

  // 13.33px is the browser's default for form controls: a fixed size that never follows the scale.
  it("gives a text box a rem font size, not the browser's fixed default", () => {
    expect(rule("input,\ntextarea,\nselect")).toMatch(/font-size:\s*[\d.]+rem/);
  });

  // A wider font or a larger scale makes a name that fitted too long; it must be cut, not run under the buttons beside it.
  it("cuts a long community or channel name in the header instead of letting it run under the buttons", () => {
    expect(rule(".main-header-title > :first-child")).toContain("text-overflow: ellipsis");
    expect(rule(".main-header-title > :first-child")).toContain("min-width: 0");
    expect(rule(".main-header > :not(:first-child)")).toContain("flex-shrink: 0");
  });

  // A label too long for its row used to run out of the page at a large scale.
  it("lets a button's label wrap instead of staying on one line", () => {
    const btn = rule(".btn");
    expect(btn).not.toContain("white-space: nowrap");
    expect(btn).toContain("max-width: 100%");
  });
});
