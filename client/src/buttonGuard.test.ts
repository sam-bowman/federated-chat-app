import { describe, expect, it } from "vitest";

// Every button in the app goes through components/Button.tsx, so its look is defined once in
// index.css. This reads every component's source and fails on the ways a button drifts:
//   1. a raw <button> that uses the shared classes (btn, btn-secondary, ..., link-button), which
//      should be a <Button> (a raw one skips type="button" and the busy state);
//   2. a <button> or <Button> with its own sizing or colours in `style` (layout is fine);
//   3. a clickable <div>, <span> or <li>, which a keyboard cannot reach (use a <button>). A wrapper that
//      only catches clicks, like a modal's backdrop, says so with role="presentation".
// Same idea as noAutofill.test.tsx for inputs.
const sources = import.meta.glob("./**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
const files = Object.entries(sources).filter(([path]) => !path.includes(".test.") && !path.endsWith("/Button.tsx"));

/** The opening tags of `<name ...>`, found by walking the text (attributes can hold `>` inside braces). */
function openingTags(source: string, name: string): { tag: string; line: number }[] {
  const found: { tag: string; line: number }[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(`<${name}`, from);
    if (start === -1) return found;
    from = start + name.length + 1;
    if (!/[\s>/]/.test(source[from] ?? "")) continue;
    let depth = 0;
    let quote: string | null = null;
    let end = from;
    for (; end < source.length; end++) {
      const c = source[end];
      if (quote) {
        if (c === quote && source[end - 1] !== "\\") quote = null;
      } else if (depth === 0 && (c === '"' || c === "'")) quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    found.push({ tag: source.slice(start, end + 1), line: source.slice(0, start).split("\n").length });
  }
}

function attribute(tag: string, name: string): string | null {
  const at = tag.search(new RegExp(`\\s${name}=`));
  if (at === -1) return null;
  const valueStart = at + name.length + 2;
  if (tag[valueStart] === '"') return tag.slice(valueStart + 1, tag.indexOf('"', valueStart + 1));
  if (tag[valueStart] !== "{") return null;
  let depth = 0;
  let i = valueStart;
  for (; i < tag.length; i++) {
    if (tag[i] === "{") depth++;
    else if (tag[i] === "}" && --depth === 0) break;
  }
  return tag.slice(valueStart + 1, i);
}

const SHARED_BUTTON_CLASS = /(^|[\s"'`{])(btn|btn-[a-z]+|link-button)($|[\s"'`}])/;
// What `style` must not set on a button: sizing and colours (margins, alignSelf and the like are layout).
const FORBIDDEN_STYLE = /\b(padding[A-Za-z]*|font[A-Za-z]*|lineHeight|borderRadius|border[A-Za-z]*|background[A-Za-z]*|color|height|minHeight)\s*:/;

describe("button styling", () => {
  it("finds the source files and the buttons in them", () => {
    expect(files.length).toBeGreaterThan(20);
    const total = files.reduce((n, [, src]) => n + openingTags(src, "Button").length, 0);
    expect(total).toBeGreaterThan(50);
  });

  it("no raw <button> uses the shared button classes (use <Button>)", () => {
    const offenders = files.flatMap(([path, src]) =>
      openingTags(src, "button")
        .filter(({ tag }) => SHARED_BUTTON_CLASS.test(attribute(tag, "className") ?? ""))
        .map(({ line }) => `${path}:${line}`)
    );
    expect(offenders).toEqual([]);
  });

  it("no button carries its own sizing or colours in `style`", () => {
    const offenders = files.flatMap(([path, src]) =>
      ["button", "Button"].flatMap((name) =>
        openingTags(src, name)
          .filter(({ tag }) => {
            const style = attribute(tag, "style");
            // Quoted keys are CSS custom properties ("--role-color"), which only carry data.
            return style !== null && FORBIDDEN_STYLE.test(style.replace(/"[^"]*"/g, '""'));
          })
          .map(({ line }) => `${path}:${line}`)
      )
    );
    expect(offenders).toEqual([]);
  });

  it("nothing clickable is a <div>, <span> or <li> (use a <button>)", () => {
    const offenders = files.flatMap(([path, src]) =>
      ["div", "span", "li"].flatMap((name) =>
        openingTags(src, name)
          .filter(({ tag }) => /\sonClick=/.test(tag) && !/\srole="presentation"/.test(tag))
          .map(({ line }) => `${path}:${line} <${name}>`)
      )
    );
    expect(offenders).toEqual([]);
  });

  // Tabs have one component too (components/Tabs.tsx), for the same reason as buttons: the look and
  // the keyboard behaviour are written once.
  it("no tablist is built by hand (use <Tabs>)", () => {
    const offenders = files
      .filter(([path]) => !path.endsWith("/Tabs.tsx"))
      .flatMap(([path, src]) =>
        src
          .split("\n")
          .map((text, index) => ({ text, line: index + 1 }))
          .filter(({ text }) => /role=["']tab(list|panel)?["']|className=["'{`][^"'}`]*\btabs?\b/.test(text))
          .map(({ line }) => `${path}:${line}`)
      );
    expect(offenders).toEqual([]);
  });

  // The guard itself: each rule must really fire on the thing it is meant to catch.
  describe("the checks catch what they are for", () => {
    const rawShared = '<button className="btn-secondary" onClick={go}>';
    const sized = '<Button size="sm" style={{ padding: "2px 6px", marginTop: 4 }}>';
    const layoutOnly = '<Button style={{ alignSelf: "flex-start", marginTop: 4 }}>';
    const customProperty = '<Button style={{ "--role-color": role.color } as React.CSSProperties}>';

    it("a raw button with a shared class", () => {
      expect(SHARED_BUTTON_CLASS.test(attribute(openingTags(rawShared, "button")[0].tag, "className") ?? "")).toBe(true);
      expect(SHARED_BUTTON_CLASS.test("icon-button")).toBe(false);
      expect(SHARED_BUTTON_CLASS.test("message-action")).toBe(false);
    });

    it("sizing in style, but not layout or a custom property", () => {
      const flagged = (src: string) => {
        const style = attribute(openingTags(src, "Button")[0].tag, "style") ?? "";
        return FORBIDDEN_STYLE.test(style.replace(/"[^"]*"/g, '""'));
      };
      expect(flagged(sized)).toBe(true);
      expect(flagged(layoutOnly)).toBe(false);
      expect(flagged(customProperty)).toBe(false);
    });

    it("walks past a > inside an attribute", () => {
      const tags = openingTags('<Button onClick={() => go(a > b)} variant="danger">x</Button>', "Button");
      expect(tags).toHaveLength(1);
      expect(tags[0].tag).toBe('<Button onClick={() => go(a > b)} variant="danger">');
    });
  });
});
