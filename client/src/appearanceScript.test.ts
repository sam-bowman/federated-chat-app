import { beforeEach, describe, expect, it } from "vitest";
import html from "../index.html?raw";
import { FONT_CHOICES, SCALE_STEPS, applyAppearance, parseAppearance } from "./lib/appearance";

// index.html applies the UI scale and font in a tiny inline script before the first paint, so there is no flash of the
// wrong size or font. It cannot import lib/appearance.ts (it runs before any module), so the two are written twice, and
// this test is what keeps them the same: it runs the real script text from index.html against every kind of stored
// value and compares every property it sets with what the module sets.
const script = [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("script:not([src]):not([type])")]
  .map((s) => s.textContent ?? "")
  .find((text) => text.includes("--ui-scale"));

const PROPERTIES = ["--ui-scale", "--ui-font", "--font-ligatures", "--message-font", "--message-ligatures"];

function runScript(options: { stored?: string | null; screenWidth: number; storageThrows?: boolean }) {
  const set = new Map<string, string>();
  const fakeLocalStorage = {
    getItem: (key: string) => {
      if (options.storageThrows) throw new Error("blocked");
      return key === "chat.appearance" ? (options.stored ?? null) : null;
    },
  };
  const style = { setProperty: (n: string, v: string) => void set.set(n, v), removeProperty: (n: string) => void set.delete(n) };
  const fakeDocument = { documentElement: { style } };
  new Function("window", "localStorage", "document", script as string)({ screen: { width: options.screenWidth } }, fakeLocalStorage, fakeDocument);
  return Object.fromEntries(PROPERTIES.map((name) => [name, set.get(name) ?? ""]));
}

function runModule(stored: string | null, screenWidth: number) {
  for (const name of PROPERTIES) document.documentElement.style.removeProperty(name);
  let parsed: unknown = null;
  try {
    parsed = stored === null ? null : JSON.parse(stored);
  } catch {
    parsed = null;
  }
  applyAppearance(parseAppearance(parsed), screenWidth);
  return Object.fromEntries(PROPERTIES.map((name) => [name, document.documentElement.style.getPropertyValue(name)]));
}

beforeEach(() => {
  for (const name of PROPERTIES) document.documentElement.style.removeProperty(name);
});

describe("index.html appearance script", () => {
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
        expect(runScript({ stored, screenWidth: width }), `${stored} at ${width}`).toEqual(runModule(stored, width));
      }
    }
  });

  it("agrees for every font, scope and ligatures setting", () => {
    for (const font of FONT_CHOICES) {
      for (const fontScope of ["ui", "messages"]) {
        for (const ligatures of [true, false]) {
          for (const customFont of ["", "Comic Sans MS"]) {
            const stored = JSON.stringify({ v: 1, scale: 125, font, customFont, fontScope, ligatures });
            expect(runScript({ stored, screenWidth: 1920 }), stored).toEqual(runModule(stored, 1920));
          }
        }
      }
    }
  });

  it("agrees about font names it must not trust", () => {
    for (const customFont of ['x"; } body { display:none', "a;b", "a{b}", "url(x)", "a\\b", "a,b", "<b>", "a".repeat(65), "  Fira   Code ", "メイリオ", 5, null, ["x"]]) {
      const stored = JSON.stringify({ font: "custom", customFont });
      expect(runScript({ stored, screenWidth: 1920 }), stored).toEqual(runModule(stored, 1920));
    }
  });

  it("agrees about values it must not trust, including a font named like an object property", () => {
    const junk = [
      "{not json",
      "null",
      "[]",
      "3",
      '"x"',
      "{}",
      JSON.stringify({ scale: 5000 }),
      JSON.stringify({ scale: "big" }),
      JSON.stringify({ font: "__proto__" }),
      JSON.stringify({ font: "constructor" }),
      JSON.stringify({ font: "toString" }),
      JSON.stringify({ font: "jetbrains-mono", fontScope: "everywhere" }),
      JSON.stringify({ font: "fira-code", ligatures: "true" }),
    ];
    for (const stored of junk) {
      for (const width of [1920, 3840]) {
        expect(runScript({ stored, screenWidth: width }), `${stored} at ${width}`).toEqual(runModule(stored, width));
      }
    }
  });

  it("uses the automatic size and the default font when nothing is stored", () => {
    expect(runScript({ stored: null, screenWidth: 1920 })).toEqual({
      "--ui-scale": "1",
      "--ui-font": "",
      "--font-ligatures": "",
      "--message-font": "",
      "--message-ligatures": "",
    });
    expect(runScript({ stored: null, screenWidth: 3840 })["--ui-scale"]).toBe("1.5");
  });

  it("still picks the automatic size when the browser will not let the page read storage", () => {
    expect(runScript({ storageThrows: true, screenWidth: 3840 })["--ui-scale"]).toBe("1.5");
    expect(runScript({ storageThrows: true, screenWidth: 1920 })["--ui-scale"]).toBe("1");
  });
});
