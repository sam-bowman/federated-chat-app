import { describe, expect, it } from "vitest";
import { accentStyle, isHexColour, memberSinceText } from "./profile";

describe("isHexColour", () => {
  it("accepts exactly #rrggbb, in either case", () => {
    expect(isHexColour("#aa00ff")).toBe(true);
    expect(isHexColour("#AA00FF")).toBe(true);
  });

  it("rejects everything else, including anything that could carry more than a colour into a style", () => {
    for (const bad of ["red", "#fff", "#12345", "#1234567", "#gggggg", "rgb(0,0,0)", "#aa00ff; background:url(x)", "url(x)", "", null, undefined]) {
      expect(isHexColour(bad), String(bad)).toBe(false);
    }
  });
});

describe("accentStyle", () => {
  it("passes a valid colour as the --profile-accent custom property", () => {
    expect(accentStyle("#e0a030")).toEqual({ "--profile-accent": "#e0a030" });
  });

  it("gives no style for none, or for a value that is not exactly a colour", () => {
    expect(accentStyle(null)).toBeUndefined();
    expect(accentStyle(undefined)).toBeUndefined();
    expect(accentStyle("red")).toBeUndefined();
    expect(accentStyle("#e0a030;position:fixed")).toBeUndefined();
  });
});

describe("memberSinceText", () => {
  it("says the month and year", () => {
    const text = memberSinceText("2025-03-15T12:00:00.000Z");

    expect(text).toMatch(/^Member since /);
    expect(text).toContain("2025");
  });

  it("is nothing when the date is missing or is not a date", () => {
    expect(memberSinceText(null)).toBeNull();
    expect(memberSinceText(undefined)).toBeNull();
    expect(memberSinceText("")).toBeNull();
    expect(memberSinceText("not a date")).toBeNull();
  });
});
