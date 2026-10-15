import { describe, expect, it } from "vitest";
import css from "../index.css?raw";
import { COLOUR_PRESETS, SIDEBAR_BACKGROUND, hexToHsv, hexToRgb, hsvToHex, isHexColour, parseHexInput, rgbToHex, squareToSv } from "./colour";
import { contrastRatio } from "./contrast";

describe("isHexColour", () => {
  it.each(["#000000", "#ffffff", "#FF8800", "#6c7cff"])("accepts %s", (value) => {
    expect(isHexColour(value)).toBe(true);
  });

  it.each(["", "#fff", "ff8800", "#ff88", "#gggggg", "#ff88000", " #ff8800", "red", "rgb(1,2,3)"])(
    "rejects %j",
    (value) => {
      expect(isHexColour(value)).toBe(false);
    }
  );
});

describe("parseHexInput", () => {
  it.each([
    ["#ff8800", "#ff8800"],
    ["FF8800", "#ff8800"],
    ["  #Ff8800 ", "#ff8800"],
    ["#f80", "#ff8800"],
    ["abc", "#aabbcc"],
  ])("reads %j as %s", (input, expected) => {
    expect(parseHexInput(input)).toBe(expected);
  });

  // A complete colour or nothing: half-typed input is "not valid yet", never a guess.
  it.each(["", "#", "#f8", "#ff88", "#ff880", "#ff88000", "#gg0000", "hello", "##ff8800", "#ff 88 00"])(
    "gives null for %j",
    (input) => {
      expect(parseHexInput(input)).toBeNull();
    }
  );
});

describe("conversions", () => {
  it("rgb and hex agree", () => {
    expect(hexToRgb("#ff8800")).toEqual([255, 136, 0]);
    expect(rgbToHex(255, 136, 0)).toBe("#ff8800");
    expect(rgbToHex(-5, 300, 12.4)).toBe("#00ff0c"); // clamped and rounded
  });

  it.each([
    ["#000000", { h: 0, s: 0, v: 0 }],
    ["#ffffff", { h: 0, s: 0, v: 100 }],
    ["#ff0000", { h: 0, s: 100, v: 100 }],
    ["#00ff00", { h: 120, s: 100, v: 100 }],
    ["#0000ff", { h: 240, s: 100, v: 100 }],
    ["#808080", { h: 0, s: 0, v: 50 }],
  ])("%s is %j in HSV", (hex, hsv) => {
    expect(hexToHsv(hex)).toEqual(hsv);
    expect(hsvToHex(hsv)).toBe(hex);
  });

  it("round-trips a colour through HSV to within one step", () => {
    for (const hex of ["#6c7cff", "#e5556a", "#3bc47e", "#e8b84b", "#99aab5", "#a66cf0"]) {
      const [r, g, b] = hexToRgb(hex);
      const [r2, g2, b2] = hexToRgb(hsvToHex(hexToHsv(hex)));
      // HSV is held in whole degrees and percents, so each channel can differ a little.
      for (const [a, c] of [[r, r2], [g, g2], [b, b2]]) expect(Math.abs(a - c)).toBeLessThanOrEqual(3);
    }
  });

  it("wraps and clamps hue", () => {
    expect(hsvToHex({ h: 360, s: 100, v: 100 })).toBe("#ff0000");
    expect(hsvToHex({ h: -120, s: 100, v: 100 })).toBe("#0000ff");
    expect(hsvToHex({ h: 480, s: 100, v: 100 })).toBe("#00ff00");
  });
});

describe("squareToSv", () => {
  it("maps the corners and clamps outside the square", () => {
    expect(squareToSv(0, 0)).toEqual({ s: 0, v: 100 }); // top left: white
    expect(squareToSv(1, 0)).toEqual({ s: 100, v: 100 }); // top right: the pure hue
    expect(squareToSv(0, 1)).toEqual({ s: 0, v: 0 }); // bottom: black
    expect(squareToSv(1, 1)).toEqual({ s: 100, v: 0 });
    expect(squareToSv(-2, 7)).toEqual({ s: 0, v: 0 });
    expect(squareToSv(0.5, 0.25)).toEqual({ s: 50, v: 75 });
  });
});

describe("the presets", () => {
  it("are twelve distinct, valid colours", () => {
    expect(COLOUR_PRESETS).toHaveLength(12);
    expect(new Set(COLOUR_PRESETS.map((p) => p.hex)).size).toBe(12);
    expect(new Set(COLOUR_PRESETS.map((p) => p.name)).size).toBe(12);
    for (const { hex } of COLOUR_PRESETS) expect(isHexColour(hex) && hex === hex.toLowerCase()).toBe(true);
  });

  it("include the app's own accent", () => {
    expect(COLOUR_PRESETS.map((p) => p.hex)).toContain("#6c7cff");
  });

  // A role's colour is shown against the sidebar; none of the colours offered first should be hard to see on it.
  it.each(COLOUR_PRESETS)("$name ($hex) is readable on the sidebar", ({ hex }) => {
    expect(contrastRatio(hex, SIDEBAR_BACKGROUND)).toBeGreaterThanOrEqual(3);
  });

  it("use the sidebar background that index.css really has", () => {
    const bg1 = css.match(/--bg-1:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(SIDEBAR_BACKGROUND).toBe(bg1);
  });
});
