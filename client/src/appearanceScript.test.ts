import { describe, expect, it } from "vitest";
import html from "../index.html?raw";
import { SCALE_STEPS, parseAppearance, resolveScalePercent } from "./lib/appearance";

// index.html applies the UI scale in a tiny inline script before the first paint, so there is no flash of the wrong
// size. It cannot import lib/appearance.ts (it runs before any module), so the two are written twice, and this test is
// what keeps them the same: it runs the real script text from index.html against every stored value and screen width
// and compares with the module.
const script = [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("script:not([src]):not([type])")]
  .map((s) => s.textContent ?? "")
  .find((text) => text.includes("--ui-scale"));

function run(options: { stored?: string | null; screenWidth: number; storageThrows?: boolean }) {
  const set: Record<string, string> = {};
  const fakeLocalStorage = {
    getItem: (key: string) => {
      if (options.storageThrows) throw new Error("blocked");
      return key === "chat.appearance" ? (options.stored ?? null) : null;
    },
  };
  const fakeDocument = { documentElement: { style: { setProperty: (name: string, value: string) => (set[name] = value) } } };
  new Function("window", "localStorage", "document", script as string)({ screen: { width: options.screenWidth } }, fakeLocalStorage, fakeDocument);
  return set["--ui-scale"];
}

const expected = (stored: string | null, screenWidth: number) => {
  let parsed: unknown = null;
  try {
    parsed = stored === null ? null : JSON.parse(stored);
  } catch {
    parsed = null;
  }
  return String(resolveScalePercent(parseAppearance(parsed), screenWidth) / 100);
};

describe("index.html UI scale script", () => {
  it("is in index.html, in the head, before the page is drawn", () => {
    expect(script).toBeTruthy();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const inHead = [...doc.head.querySelectorAll("script:not([src])")].some((s) => s.textContent?.includes("--ui-scale"));
    expect(inHead).toBe(true);
  });

  it("agrees with lib/appearance.ts for every stored size, on every kind of screen", () => {
    for (const width of [0, 1280, 1920, 2399, 2400, 2560, 3199, 3200, 3840]) {
      for (const scale of ["auto", ...SCALE_STEPS]) {
        const stored = JSON.stringify({ v: 1, scale });
        expect(run({ stored, screenWidth: width }), `${stored} at ${width}`).toBe(expected(stored, width));
      }
    }
  });

  it("uses the automatic size when nothing is stored", () => {
    expect(run({ stored: null, screenWidth: 1920 })).toBe("1");
    expect(run({ stored: null, screenWidth: 2560 })).toBe("1.25");
    expect(run({ stored: null, screenWidth: 3840 })).toBe("1.5");
  });

  it("agrees with the module about values it must not trust", () => {
    for (const stored of ["{not json", "null", "[]", "3", '"x"', JSON.stringify({ scale: 5000 }), JSON.stringify({ scale: 101 }), JSON.stringify({ scale: "big" }), JSON.stringify({ scale: null }), "{}"]) {
      for (const width of [1920, 3840]) {
        expect(run({ stored, screenWidth: width }), `${stored} at ${width}`).toBe(expected(stored, width));
      }
    }
  });

  it("still picks the automatic size when the browser will not let the page read storage", () => {
    expect(run({ storageThrows: true, screenWidth: 3840 })).toBe("1.5");
    expect(run({ storageThrows: true, screenWidth: 1920 })).toBe("1");
  });
});
