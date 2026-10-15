import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import { COLOUR_PRESETS } from "./colour";
import { characters, communityTile, defaultIconText, normaliseIconText, readableTextColour } from "./communityIcon";

describe("characters", () => {
  it("counts whole characters, not UTF-16 units", () => {
    expect(characters("ab")).toEqual(["a", "b"]);
    expect(characters("🎲🎮")).toHaveLength(2);
    expect(characters("👍🏽")).toHaveLength(1); // an emoji with a skin tone
    expect(characters("🇬🇧")).toHaveLength(1); // a flag
    expect(characters("")).toEqual([]);
  });
});

describe("defaultIconText", () => {
  it.each([
    ["Book Club", "BO"],
    ["x", "X"],
    ["  spaced out", "SP"],
    ["日本語の会", "日本"],
    ["", ""],
  ])("for %j is %j", (name, expected) => {
    expect(defaultIconText(name)).toBe(expected);
  });

  it("never splits an emoji in half, which slicing the string would", () => {
    expect(defaultIconText("🎲Dice")).toBe("🎲D");
    expect("🎲Dice".slice(0, 2)).not.toBe("🎲D"); // the old way cut the emoji
  });
});

describe("normaliseIconText", () => {
  it.each([
    ["A", "A"],
    ["  bc ", "bc"],
    ["XYZ", "XYZ"],
    ["🎲", "🎲"],
    ["🎲🎮🎯", "🎲🎮🎯"],
  ])("accepts %j as %j", (input, expected) => {
    expect(normaliseIconText(input)).toBe(expected);
  });

  it.each(["", "   ", "ABCD", "🎲🎮🎯🎪", "A\nB", "A\tB", "A\u0000"])("rejects %j", (input) => {
    expect(normaliseIconText(input)).toBeNull();
  });
});

describe("readableTextColour", () => {
  it("picks white on dark colours and black on light ones", () => {
    expect(readableTextColour("#000000")).toBe("#ffffff");
    expect(readableTextColour("#1e1f26")).toBe("#ffffff");
    expect(readableTextColour("#ffffff")).toBe("#000000");
    expect(readableTextColour("#e8b84b")).toBe("#000000"); // gold
  });

  // Every colour the picker offers first gets a text colour that is readable (AA for normal text) on it.
  it.each(COLOUR_PRESETS)("is readable (4.5:1 or better) on the $name preset", ({ hex }) => {
    expect(contrastRatio(readableTextColour(hex), hex)).toBeGreaterThanOrEqual(4.5);
  });

  it("is at least 4.5:1 across a sweep of colours (the worst case is mid-tones)", () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const hex = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
          expect(contrastRatio(readableTextColour(hex), hex)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe("communityTile", () => {
  const community = { name: "Book Club", iconText: null, iconColor: null };

  it("is the first two letters on the default look when nothing is chosen", () => {
    expect(communityTile(community)).toEqual({ label: "BO", colours: null, small: false });
  });

  it("uses the chosen letters and colour, with a text colour that reads on it", () => {
    expect(communityTile({ ...community, iconText: "bc", iconColor: "#e8b84b" })).toEqual({
      label: "bc",
      colours: { background: "#e8b84b", text: "#000000" },
      small: false,
    });
  });

  it("falls back to the default letters when the chosen ones are blank", () => {
    expect(communityTile({ ...community, iconText: "   " }).label).toBe("BO");
  });

  it("draws three characters smaller, and one or two normally", () => {
    expect(communityTile({ ...community, iconText: "ABC" }).small).toBe(true);
    expect(communityTile({ ...community, iconText: "AB" }).small).toBe(false);
    expect(communityTile({ ...community, iconText: "A" }).small).toBe(false);
    expect(communityTile({ ...community, iconText: "🎲🎮🎯" }).small).toBe(true);
  });

  it("can have a colour with the default letters, and letters with the default colour", () => {
    expect(communityTile({ ...community, iconColor: "#3bc47e" })).toMatchObject({ label: "BO", colours: { background: "#3bc47e" } });
    expect(communityTile({ ...community, iconText: "Z" })).toMatchObject({ label: "Z", colours: null });
  });
});
