import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { noAutofill, passwordManagerIgnore } from "./noAutofill";

// Every component and page, as source text (Vite's ?raw), so a new input can't slip in unchecked.
const sources = import.meta.glob(["../**/*.tsx", "!../**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

afterEach(cleanup);

describe("noAutofill", () => {
  it("opts out of every password manager that documents a way to, plus the standard autocomplete", () => {
    const { container } = render(
      <>
        <input data-testid="i" {...noAutofill} />
        <textarea data-testid="t" {...noAutofill} />
      </>
    );
    for (const el of Array.from(container.querySelectorAll("input, textarea"))) {
      expect(el.getAttribute("autocomplete")).toBe("off");
      expect(el.hasAttribute("data-1p-ignore")).toBe(true); // 1Password
      expect(el.getAttribute("data-lpignore")).toBe("true"); // LastPass wants the explicit "true"
      expect(el.hasAttribute("data-bwignore")).toBe(true); // Bitwarden
      expect(el.getAttribute("data-form-type")).toBe("other"); // Dashlane
      expect(el.hasAttribute("data-protonpass-ignore")).toBe(true); // Proton Pass
    }
  });

  it("passwordManagerIgnore carries the vendor hints without taking over autocomplete", () => {
    expect(Object.keys(passwordManagerIgnore)).not.toContain("autoComplete");
    expect(Object.keys(noAutofill)).toContain("autoComplete");
  });
});

// Walks to the '>' that closes a JSX tag, skipping over {...} expressions and quoted strings
// (props such as onChange={(e) => ...} contain '>' themselves).
function tagEnd(source: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
    } else if (c === ">" && depth === 0 && source[i - 1] !== "=") {
      return i + 1;
    }
  }
  throw new Error("unterminated tag");
}

const EXEMPT_TYPES = ["checkbox", "file", "color", "password", "radio"];

describe("free-text inputs", () => {
  const offenders: string[] = [];
  let checked = 0;

  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/<(input|textarea)(?=[\s/>])/g)) {
      const start = match.index!;
      const tag = source.slice(start, tagEnd(source, start + match[0].length));
      checked++;
      const deliberate =
        tag.includes("noAutofill") || // the opt-out for ordinary text boxes
        tag.includes("passwordManagerIgnore") || // the opt-out, with its own real autocomplete token
        /autoComplete=/.test(tag) || // names what it really is (username, one-time-code, url ...)
        EXEMPT_TYPES.some((t) => tag.includes(`type="${t}"`));
      if (!deliberate) {
        const line = source.slice(0, start).split("\n").length;
        offenders.push(`${file.replace("../", "client/src/")}:${line}`);
      }
    }
  }

  it("finds the inputs it is meant to check", () => {
    expect(checked).toBeGreaterThan(25);
  });

  it("has none that a password manager could mistake for a login box", () => {
    // Spread {...noAutofill} onto it (see lib/noAutofill.ts), or give it a real autocomplete value.
    expect(offenders).toEqual([]);
  });
});
