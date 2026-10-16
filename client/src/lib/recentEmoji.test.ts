import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECENT_EMOJI, RECENT_EMOJI_KEY, getRecentEmoji, rememberEmoji } from "./recentEmoji";

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("recent emoji", () => {
  it("is empty by default", () => {
    expect(getRecentEmoji()).toEqual([]);
  });

  it("puts the latest first and moves a repeat to the front without duplicating it", () => {
    rememberEmoji("😀");
    rememberEmoji("🚀");
    rememberEmoji("😀");
    expect(getRecentEmoji()).toEqual(["😀", "🚀"]);
  });

  it("keeps only the most recent ones", () => {
    for (let i = 0; i < MAX_RECENT_EMOJI + 5; i++) rememberEmoji(String.fromCodePoint(0x1f600 + i));
    const recent = getRecentEmoji();
    expect(recent).toHaveLength(MAX_RECENT_EMOJI);
    expect(recent[0]).toBe(String.fromCodePoint(0x1f600 + MAX_RECENT_EMOJI + 4));
  });

  it("ignores corrupt or hand-edited stored values", () => {
    for (const bad of ["not json", "null", "42", '{"a":1}', '"x"']) {
      localStorage.setItem(RECENT_EMOJI_KEY, bad);
      expect(getRecentEmoji()).toEqual([]);
    }
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(["😀", 5, null, "", "x".repeat(60), "🚀"]));
    expect(getRecentEmoji()).toEqual(["😀", "🚀"]);
  });

  it("survives localStorage throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(getRecentEmoji()).toEqual([]);
    expect(() => rememberEmoji("😀")).not.toThrow();
  });
});
