import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPEARANCE,
  DEFAULT_FONT_STACK,
  FONT_CHOICES,
  SCALE_STEPS,
  SYSTEM_MONO_STACK,
  appearanceForShortcut,
  applyAppearance,
  autoScalePercent,
  fontHasLigatures,
  fontStack,
  getAppearance,
  loadAppearance,
  parseAppearance,
  resolveScalePercent,
  sanitizeFontName,
  saveAppearance,
  setAppearance,
  startAppearance,
  stepScale,
  type Appearance,
} from "./appearance";

const withScale = (scale: Appearance["scale"]): Appearance => ({ ...DEFAULT_APPEARANCE, scale });
const prop = (name: string) => document.documentElement.style.getPropertyValue(name);

beforeEach(() => {
  localStorage.clear();
  for (const name of ["--ui-scale", "--ui-font", "--font-ligatures", "--message-font", "--message-ligatures"]) {
    document.documentElement.style.removeProperty(name);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("autoScalePercent", () => {
  it("leaves a laptop-sized or full-HD screen at 100%", () => {
    for (const width of [1280, 1366, 1440, 1536, 1920, 2399]) expect(autoScalePercent(width), String(width)).toBe(100);
  });

  it("makes a 1440p monitor at 100% system scaling 125%", () => {
    expect(autoScalePercent(2400)).toBe(125);
    expect(autoScalePercent(2560)).toBe(125);
    expect(autoScalePercent(3199)).toBe(125);
  });

  it("makes a 4K monitor at 100% system scaling 150%", () => {
    expect(autoScalePercent(3200)).toBe(150);
    expect(autoScalePercent(3840)).toBe(150);
  });

  it("gives a 4K monitor the system already scales (2560 css pixels wide) the size for that width, not 150%", () => {
    expect(autoScalePercent(3840 / 1.5)).toBe(125);
  });
});

describe("resolveScalePercent", () => {
  it("is the chosen percent, or the automatic one", () => {
    expect(resolveScalePercent({ scale: 150 }, 1920)).toBe(150);
    expect(resolveScalePercent({ scale: "auto" }, 3840)).toBe(150);
    expect(resolveScalePercent({ scale: "auto" }, 1920)).toBe(100);
  });
});

describe("sanitizeFontName", () => {
  it("accepts the names of real fonts, trimmed and with spaces collapsed", () => {
    expect(sanitizeFontName("Fira Code")).toBe("Fira Code");
    expect(sanitizeFontName("  Comic   Sans MS ")).toBe("Comic Sans MS");
    expect(sanitizeFontName("Noto Sans CJK JP")).toBe("Noto Sans CJK JP");
    expect(sanitizeFontName("MS-Gothic_2.0")).toBe("MS-Gothic_2.0");
    expect(sanitizeFontName("メイリオ")).toBe("メイリオ");
  });

  it("turns any run of whitespace, line breaks included, into one space", () => {
    expect(sanitizeFontName("a\nb")).toBe("a b");
    expect(sanitizeFontName("a \t\r\n b")).toBe("a b");
  });

  it("rejects anything that could end a string, a declaration or a rule in the stylesheet it is written into", () => {
    for (const bad of [
      'Evil"; } body { display: none',
      "Evil'; color: red",
      "a;b",
      "a{b}",
      "a\\b",
      "a(b)",
      "a/b",
      "<style>",
      "a,b",
      "url(x)",
    ]) {
      expect(sanitizeFontName(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects empty, spaces only, too long and not a string", () => {
    expect(sanitizeFontName("")).toBeNull();
    expect(sanitizeFontName("   ")).toBeNull();
    expect(sanitizeFontName("a".repeat(65))).toBeNull();
    expect(sanitizeFontName("a".repeat(64))).toBe("a".repeat(64));
    for (const bad of [null, undefined, 5, {}, []]) expect(sanitizeFontName(bad)).toBeNull();
  });
});

describe("fontStack", () => {
  const stack = (font: Appearance["font"], customFont = "") => fontStack({ font, customFont });

  it("is nothing for the default font, so the stylesheet's own stack applies", () => {
    expect(stack("default")).toBeNull();
  });

  it("is the system monospaces for Monospace (system), with nothing downloaded", () => {
    expect(stack("mono-system")).toBe(SYSTEM_MONO_STACK);
    expect(SYSTEM_MONO_STACK).toContain("Cascadia Mono");
    // Cascadia Code (the one with ligatures) is tried before Cascadia Mono (the same font without them): with Mono first,
    // "Monospace (system)" offered a Ligatures option that could never do anything (#208).
    expect(SYSTEM_MONO_STACK.indexOf('"Cascadia Code"')).toBe(0);
    expect(SYSTEM_MONO_STACK.indexOf('"Cascadia Code"')).toBeLessThan(SYSTEM_MONO_STACK.indexOf('"Cascadia Mono"'));
    expect(SYSTEM_MONO_STACK.endsWith("monospace")).toBe(true);
  });

  it("puts a bundled font first, with the system monospaces behind it", () => {
    expect(stack("jetbrains-mono")).toBe(`"JetBrains Mono", ${SYSTEM_MONO_STACK}`);
    expect(stack("ibm-plex-mono")).toBe(`"IBM Plex Mono", ${SYSTEM_MONO_STACK}`);
    expect(stack("fira-code")).toBe(`"Fira Code", ${SYSTEM_MONO_STACK}`);
  });

  it("quotes a custom font and falls back to the usual stack if it is not installed", () => {
    expect(stack("custom", "Comic Sans MS")).toBe(`"Comic Sans MS", ${DEFAULT_FONT_STACK}`);
  });

  it("ignores a custom font with no usable name", () => {
    expect(stack("custom", "")).toBeNull();
    expect(stack("custom", 'x"; y')).toBeNull();
  });
});

describe("fontHasLigatures", () => {
  it("is true for the fonts that draw them and for fonts we cannot know, false for the rest", () => {
    expect(fontHasLigatures("jetbrains-mono")).toBe(true);
    expect(fontHasLigatures("fira-code")).toBe(true);
    expect(fontHasLigatures("mono-system")).toBe(true);
    expect(fontHasLigatures("custom")).toBe(true);
    expect(fontHasLigatures("ibm-plex-mono")).toBe(false);
    expect(fontHasLigatures("default")).toBe(false);
  });
});

describe("parseAppearance", () => {
  it("accepts auto and every size offered", () => {
    expect(parseAppearance({ scale: "auto" }).scale).toBe("auto");
    for (const step of SCALE_STEPS) expect(parseAppearance({ scale: step }).scale).toBe(step);
  });

  it("falls back to the defaults for anything else, so a damaged value can never break the page", () => {
    for (const bad of [{ scale: 5000 }, { scale: 0 }, { scale: -100 }, { scale: 101 }, { scale: "big" }, { scale: null }, { scale: NaN }, {}, null, "x", 3, []]) {
      expect(parseAppearance(bad), JSON.stringify(bad)).toEqual(DEFAULT_APPEARANCE);
    }
  });

  it("accepts every font offered", () => {
    for (const font of FONT_CHOICES) {
      const parsed = parseAppearance({ font, customFont: "Fira Code" });
      expect(parsed.font).toBe(font);
    }
  });

  it("falls back to the default font for one it does not know, including names that exist on every object", () => {
    for (const bad of ["comic-sans", "", null, 5, "__proto__", "constructor", "toString"]) {
      expect(parseAppearance({ font: bad }).font, String(bad)).toBe("default");
    }
  });

  it("needs a usable name for a custom font, and drops an unsafe one", () => {
    expect(parseAppearance({ font: "custom", customFont: "Comic Sans MS" })).toMatchObject({ font: "custom", customFont: "Comic Sans MS" });
    expect(parseAppearance({ font: "custom", customFont: "" }).font).toBe("default");
    expect(parseAppearance({ font: "custom", customFont: 'x"; }' }).font).toBe("default");
    expect(parseAppearance({ font: "jetbrains-mono", customFont: 'x"; }' }).customFont).toBe("");
  });

  it("reads the scope and ligatures strictly", () => {
    expect(parseAppearance({ fontScope: "messages" }).fontScope).toBe("messages");
    expect(parseAppearance({ fontScope: "everything" }).fontScope).toBe("ui");
    expect(parseAppearance({ ligatures: true }).ligatures).toBe(true);
    for (const bad of ["true", 1, "yes", null]) expect(parseAppearance({ ligatures: bad }).ligatures).toBe(false);
  });

  it("reads what an earlier version stored, which had only a size", () => {
    expect(parseAppearance({ v: 1, scale: 150 })).toEqual({ ...DEFAULT_APPEARANCE, scale: 150 });
  });
});

describe("storage", () => {
  it("is the defaults when nothing is stored", () => {
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it("remembers every setting", () => {
    const chosen: Appearance = { scale: 150, font: "custom", customFont: "Comic Sans MS", fontScope: "messages", ligatures: true };

    saveAppearance(chosen);

    expect(loadAppearance()).toEqual(chosen);
  });

  it("forgets the stored value only when everything is back to the defaults", () => {
    saveAppearance({ ...DEFAULT_APPEARANCE, font: "fira-code" });
    expect(localStorage.getItem("chat.appearance")).not.toBeNull();

    saveAppearance(DEFAULT_APPEARANCE);
    expect(localStorage.getItem("chat.appearance")).toBeNull();
  });

  it("is the defaults when what is stored is not JSON", () => {
    localStorage.setItem("chat.appearance", "{not json");

    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it("keeps working when the browser will not let the page store anything", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
    expect(() => saveAppearance(withScale(125))).not.toThrow();
  });
});

describe("applying the size", () => {
  it("sets --ui-scale on the page, 1 being 100%", () => {
    applyAppearance(withScale(125), 1920);
    expect(prop("--ui-scale")).toBe("1.25");

    applyAppearance(withScale(75), 1920);
    expect(prop("--ui-scale")).toBe("0.75");
  });

  it("resolves auto from the screen", () => {
    applyAppearance(withScale("auto"), 3840);

    expect(prop("--ui-scale")).toBe("1.5");
  });

  it("changing it through the store applies it, remembers it, and tells whoever is listening", () => {
    startAppearance();

    setAppearance(withScale(175));

    expect(getAppearance().scale).toBe(175);
    expect(prop("--ui-scale")).toBe("1.75");
    expect(JSON.parse(localStorage.getItem("chat.appearance")!)).toMatchObject({ v: 1, scale: 175 });
  });

  it("follows a change made in another tab", () => {
    startAppearance();
    localStorage.setItem("chat.appearance", JSON.stringify({ v: 1, scale: 90, font: "fira-code" }));

    window.dispatchEvent(new StorageEvent("storage", { key: "chat.appearance" }));

    expect(getAppearance()).toMatchObject({ scale: 90, font: "fira-code" });
    expect(prop("--ui-scale")).toBe("0.9");
    expect(prop("--ui-font")).toContain("Fira Code");
  });

  it("ignores another tab changing something unrelated", () => {
    startAppearance();
    setAppearance(withScale(110));

    window.dispatchEvent(new StorageEvent("storage", { key: "chat.sidebarWidth" }));

    expect(getAppearance().scale).toBe(110);
  });
});

describe("applying the font", () => {
  const apply = (over: Partial<Appearance>) => applyAppearance({ ...DEFAULT_APPEARANCE, ...over }, 1920);

  it("sets nothing for the default font, so the stylesheet's own stack and ligatures apply", () => {
    apply({});

    for (const name of ["--ui-font", "--font-ligatures", "--message-font", "--message-ligatures"]) expect(prop(name), name).toBe("");
  });

  it("puts a font chosen for the whole UI in --ui-font, with ligatures off unless asked for", () => {
    apply({ font: "jetbrains-mono" });

    expect(prop("--ui-font")).toBe(`"JetBrains Mono", ${SYSTEM_MONO_STACK}`);
    expect(prop("--font-ligatures")).toBe("none");
    expect(prop("--message-font")).toBe("");
    expect(prop("--message-ligatures")).toBe("");
  });

  it("leaves ligatures to the font when they are turned on", () => {
    apply({ font: "fira-code", ligatures: true });

    expect(prop("--ui-font")).toContain("Fira Code");
    expect(prop("--font-ligatures")).toBe("");
  });

  it("puts a font chosen for messages only in --message-font, and leaves the rest of the UI alone", () => {
    apply({ font: "ibm-plex-mono", fontScope: "messages" });

    expect(prop("--message-font")).toBe(`"IBM Plex Mono", ${SYSTEM_MONO_STACK}`);
    expect(prop("--message-ligatures")).toBe("none");
    expect(prop("--ui-font")).toBe("");
    expect(prop("--font-ligatures")).toBe("");
  });

  it("moves from one scope to the other cleanly, and back to the default font", () => {
    apply({ font: "fira-code" });
    apply({ font: "fira-code", fontScope: "messages" });
    expect(prop("--ui-font")).toBe("");
    expect(prop("--message-font")).toContain("Fira Code");

    apply({});
    expect(prop("--message-font")).toBe("");
    expect(prop("--message-ligatures")).toBe("");
  });

  it("uses a custom font with the usual stack behind it", () => {
    apply({ font: "custom", customFont: "Comic Sans MS" });

    expect(prop("--ui-font")).toBe(`"Comic Sans MS", ${DEFAULT_FONT_STACK}`);
  });

  it("does not let an unsafe name into the page even if it got as far as the settings", () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, font: "custom", customFont: 'x"; } body { display:none' }, 1920);

    expect(prop("--ui-font")).toBe("");
  });

  it("changing the font through the store keeps the size", () => {
    startAppearance();
    setAppearance(withScale(150));

    setAppearance({ ...getAppearance(), font: "fira-code" });

    expect(prop("--ui-scale")).toBe("1.5");
    expect(prop("--ui-font")).toContain("Fira Code");
  });
});

describe("stepScale and the keyboard shortcuts", () => {
  it("steps to the next size up and down from where the UI is, and stops at the ends", () => {
    expect(stepScale(withScale(100), 1, 1920).scale).toBe(110);
    expect(stepScale(withScale(100), -1, 1920).scale).toBe(90);
    expect(stepScale(withScale(200), 1, 1920).scale).toBe(200);
    expect(stepScale(withScale(75), -1, 1920).scale).toBe(75);
  });

  it("steps from the automatic size when that is what is in effect", () => {
    expect(stepScale(withScale("auto"), 1, 3840).scale).toBe(175); // auto is 150 here
    expect(stepScale(withScale("auto"), -1, 3840).scale).toBe(125);
  });

  it("changes only the size, never the font", () => {
    const chosen: Appearance = { ...DEFAULT_APPEARANCE, scale: 100, font: "fira-code", fontScope: "messages", ligatures: true };

    expect(stepScale(chosen, 1, 1920)).toEqual({ ...chosen, scale: 110 });
  });

  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = { ctrlKey: true }) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });

  it("maps Ctrl or Cmd with + / = to larger, - to smaller and 0 to auto size", () => {
    const at100 = withScale(100);
    expect(appearanceForShortcut(key("+"), at100, 1920)?.scale).toBe(110);
    expect(appearanceForShortcut(key("="), at100, 1920)?.scale).toBe(110);
    expect(appearanceForShortcut(key("-"), at100, 1920)?.scale).toBe(90);
    expect(appearanceForShortcut(key("0", { metaKey: true }), withScale(150), 1920)?.scale).toBe("auto");
  });

  it("goes back to auto size with 0 but keeps the chosen font", () => {
    const chosen: Appearance = { ...DEFAULT_APPEARANCE, scale: 150, font: "jetbrains-mono" };

    expect(appearanceForShortcut(key("0"), chosen, 1920)).toEqual({ ...chosen, scale: "auto" });
  });

  it("ignores the keys without Ctrl or Cmd, with Alt, and other keys", () => {
    expect(appearanceForShortcut(key("+", {}), withScale(100), 1920)).toBeNull();
    expect(appearanceForShortcut(key("+", { ctrlKey: true, altKey: true }), withScale(100), 1920)).toBeNull();
    expect(appearanceForShortcut(key("a"), withScale(100), 1920)).toBeNull();
  });
});
