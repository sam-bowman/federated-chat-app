import { describe, expect, it } from "vitest";
import { isIconUrl, sanitizeIconColor, sanitizeIconText, sanitizeRemoteIconUrl } from "./communityIcon.js";

describe("sanitizeIconText", () => {
  it.each([
    ["A", "A"],
    ["bc", "bc"],
    ["XYZ", "XYZ"],
    ["  ab  ", "ab"], // trimmed
    ["日本", "日本"],
    ["🎲", "🎲"],
    ["👍🏽", "👍🏽"], // one character with a skin tone
    ["🇬🇧", "🇬🇧"], // a flag is one character
    ["🎲🎮🎯", "🎲🎮🎯"],
    ["é", "é"],
  ])("accepts %j as %j", (input, expected) => {
    expect(sanitizeIconText(input)).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["only spaces", "   "],
    ["four characters", "ABCD"],
    ["four emoji", "🎲🎮🎯🎪"],
    ["a newline", "A\nB"],
    ["a tab", "A\tB"],
    ["a NUL", "A\u0000"],
    ["an escape", "\u001b[31m"],
    ["a line separator", "A B"],
    ["a number", 12],
    ["null", null],
    ["undefined", undefined],
    ["an object", { text: "A" }],
  ])("rejects %s", (_name, input) => {
    expect(sanitizeIconText(input)).toBeNull();
  });

  // The letters are user data shown on every member's screen: markup is only ever text, but it is still a length limit.
  it("treats markup as ordinary characters, within the limit", () => {
    expect(sanitizeIconText("<b>")).toBe("<b>");
    expect(sanitizeIconText("<img src=x>")).toBeNull();
  });
});

describe("sanitizeIconColor", () => {
  it.each([
    ["#ff8800", "#ff8800"],
    ["#FF8800", "#ff8800"],
    ["#6c7cff", "#6c7cff"],
  ])("accepts %s as %s", (input, expected) => {
    expect(sanitizeIconColor(input)).toBe(expected);
  });

  it.each(["", "#fff", "ff8800", "#ff88000", "#gggggg", "red", "rgb(1,2,3)", "#ff8800;background:url(x)", " #ff8800", 5, null, undefined])(
    "rejects %j",
    (input) => {
      expect(sanitizeIconColor(input)).toBeNull();
    }
  );
});

describe("isIconUrl", () => {
  it.each([
    "/uploads/abc123.png",
    "/uploads/a.b.c.jpg",
    "https://cdn.example/icons/a.png",
    "http://localhost:4000/uploads/a.png",
    "HTTPS://CDN.EXAMPLE/a.png",
  ])("accepts %s", (url) => {
    expect(isIconUrl(url)).toBe(true);
  });

  it.each([
    "",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "//cdn.example/a.png",
    "/etc/passwd",
    "/uploads/",
    "/uploads//a.png",
    "/uploads/a b.png",
    "https://cdn.example/a b.png",
    "ftp://files.example/a.png",
    "x".repeat(3000),
    5,
    null,
    undefined,
  ])("rejects %j", (url) => {
    expect(isIconUrl(url)).toBe(false);
  });
});

describe("sanitizeRemoteIconUrl", () => {
  it("keeps an absolute http(s) URL from another server", () => {
    expect(sanitizeRemoteIconUrl("https://far.example/uploads/a.png")).toBe("https://far.example/uploads/a.png");
  });

  // A path from another server would be read against OUR server: wrong picture or none, so it is dropped.
  it.each(["/uploads/a.png", "javascript:alert(1)", "", null, undefined, 3])("drops %j", (value) => {
    expect(sanitizeRemoteIconUrl(value)).toBeNull();
  });
});
