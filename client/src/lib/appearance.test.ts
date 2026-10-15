import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPEARANCE,
  SCALE_STEPS,
  appearanceForShortcut,
  applyAppearance,
  autoScalePercent,
  getAppearance,
  loadAppearance,
  parseAppearance,
  resolveScalePercent,
  saveAppearance,
  setAppearance,
  startAppearance,
  stepScale,
} from "./appearance";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("--ui-scale");
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

  it("leaves a 4K monitor the system already scales to 2560 css pixels to the 125% for that width, not 150%", () => {
    // 3840 physical pixels at 150% system scaling is 2560 CSS pixels wide.
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

describe("parseAppearance", () => {
  it("accepts auto and every size offered", () => {
    expect(parseAppearance({ scale: "auto" })).toEqual({ scale: "auto" });
    for (const step of SCALE_STEPS) expect(parseAppearance({ scale: step })).toEqual({ scale: step });
  });

  it("falls back to auto for anything else, so a damaged value can never break the page", () => {
    for (const bad of [{ scale: 5000 }, { scale: 0 }, { scale: -100 }, { scale: 101 }, { scale: "big" }, { scale: null }, { scale: NaN }, {}, null, "x", 3, []]) {
      expect(parseAppearance(bad), JSON.stringify(bad)).toEqual({ scale: "auto" });
    }
  });
});

describe("storage", () => {
  it("is auto when nothing is stored", () => {
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it("remembers a chosen size, and forgets the choice when it goes back to auto", () => {
    saveAppearance({ scale: 150 });
    expect(loadAppearance()).toEqual({ scale: 150 });

    saveAppearance({ scale: "auto" });
    expect(localStorage.getItem("chat.appearance")).toBeNull();
    expect(loadAppearance()).toEqual({ scale: "auto" });
  });

  it("is auto when what is stored is not JSON", () => {
    localStorage.setItem("chat.appearance", "{not json");

    expect(loadAppearance()).toEqual({ scale: "auto" });
  });

  it("keeps working when the browser will not let the page store anything", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(loadAppearance()).toEqual({ scale: "auto" });
    expect(() => saveAppearance({ scale: 125 })).not.toThrow();
  });
});

describe("applying", () => {
  const scaleProperty = () => document.documentElement.style.getPropertyValue("--ui-scale");

  it("sets --ui-scale on the page, 1 being 100%", () => {
    applyAppearance({ scale: 125 }, 1920);
    expect(scaleProperty()).toBe("1.25");

    applyAppearance({ scale: 75 }, 1920);
    expect(scaleProperty()).toBe("0.75");
  });

  it("resolves auto from the screen", () => {
    applyAppearance({ scale: "auto" }, 3840);

    expect(scaleProperty()).toBe("1.5");
  });

  it("changing it through the store applies it, remembers it, and tells whoever is listening", () => {
    startAppearance();

    setAppearance({ scale: 175 });

    expect(getAppearance()).toEqual({ scale: 175 });
    expect(scaleProperty()).toBe("1.75");
    expect(JSON.parse(localStorage.getItem("chat.appearance")!)).toEqual({ v: 1, scale: 175 });
  });

  it("follows a change made in another tab", () => {
    startAppearance();
    localStorage.setItem("chat.appearance", JSON.stringify({ v: 1, scale: 90 }));

    window.dispatchEvent(new StorageEvent("storage", { key: "chat.appearance" }));

    expect(getAppearance()).toEqual({ scale: 90 });
    expect(scaleProperty()).toBe("0.9");
  });

  it("ignores another tab changing something unrelated", () => {
    startAppearance();
    setAppearance({ scale: 110 });

    window.dispatchEvent(new StorageEvent("storage", { key: "chat.sidebarWidth" }));

    expect(getAppearance()).toEqual({ scale: 110 });
  });
});

describe("stepScale and the keyboard shortcuts", () => {
  it("steps to the next size up and down from where the UI is, and stops at the ends", () => {
    expect(stepScale({ scale: 100 }, 1, 1920)).toEqual({ scale: 110 });
    expect(stepScale({ scale: 100 }, -1, 1920)).toEqual({ scale: 90 });
    expect(stepScale({ scale: 200 }, 1, 1920)).toEqual({ scale: 200 });
    expect(stepScale({ scale: 75 }, -1, 1920)).toEqual({ scale: 75 });
  });

  it("steps from the automatic size when that is what is in effect", () => {
    expect(stepScale({ scale: "auto" }, 1, 3840)).toEqual({ scale: 175 }); // auto is 150 here
    expect(stepScale({ scale: "auto" }, -1, 3840)).toEqual({ scale: 125 });
  });

  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = { ctrlKey: true }) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });

  it("maps Ctrl or Cmd with + / = to larger, - to smaller and 0 to auto", () => {
    const at100 = { scale: 100 } as const;
    expect(appearanceForShortcut(key("+"), at100, 1920)).toEqual({ scale: 110 });
    expect(appearanceForShortcut(key("="), at100, 1920)).toEqual({ scale: 110 });
    expect(appearanceForShortcut(key("-"), at100, 1920)).toEqual({ scale: 90 });
    expect(appearanceForShortcut(key("0", { metaKey: true }), { scale: 150 }, 1920)).toEqual({ scale: "auto" });
  });

  it("ignores the keys without Ctrl or Cmd, with Alt, and other keys", () => {
    expect(appearanceForShortcut(key("+", {}), { scale: 100 }, 1920)).toBeNull();
    expect(appearanceForShortcut(key("+", { ctrlKey: true, altKey: true }), { scale: 100 }, 1920)).toBeNull();
    expect(appearanceForShortcut(key("a"), { scale: 100 }, 1920)).toBeNull();
  });
});
