import { describe, expect, it } from "vitest";
import compact from "emojibase-data/en/compact.json" with { type: "json" };
import { canonicalEmoji, isSingleEmoji } from "./emoji.js";

describe("isSingleEmoji", () => {
  it.each([
    ["a plain emoji", "😀"],
    ["the five default reactions", "👍"],
    ["a heart with a variation selector", "❤️"],
    ["a skin-toned emoji", "👍🏽"],
    ["a ZWJ family", "👨‍👩‍👧‍👦"],
    ["a ZWJ profession", "👩🏾‍🚀"],
    ["a flag", "🇳🇿"],
    ["a subdivision flag (tag sequence)", "🏴󠁧󠁢󠁥󠁮󠁧󠁿"],
    ["a keycap", "1️⃣"],
    ["the hash keycap", "#️⃣"],
    ["a text-presentation pictograph", "☺"],
  ])("accepts %s", (_name, value) => {
    expect(isSingleEmoji(value)).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["a word", "hello"],
    ["a single letter", "a"],
    ["a digit", "1"],
    ["a bare keycap base", "#"],
    ["a space", " "],
    ["two emoji", "😀😀"],
    ["an emoji with text after it", "😀a"],
    ["text before an emoji", "a😀"],
    ["an emoji with a newline", "😀\n"],
    ["a lone variation selector", "️"],
    ["a lone zero-width joiner", "‍"],
    ["a lone regional indicator pair half", "🇳"],
    ["a custom emoticon trigger", ":party:"],
    ["markup", "<b>😀</b>"],
    ["something over the length limit", "👨‍👩‍👧‍👦".repeat(10)],
  ])("rejects %s", (_name, value) => {
    expect(isSingleEmoji(value)).toBe(false);
  });

  // The client's picker is built from this same dataset, so everything it can offer must be
  // accepted here - otherwise picking an emoji would fail with a 400.
  it("accepts every emoji in the dataset the client's picker is built from", () => {
    const rejected = (compact as { unicode: string; group?: number }[])
      // Regional-indicator letters and skin-tone swatches are components, not reactions, and the
      // picker leaves them out.
      .filter((e) => e.group !== undefined && e.group !== 2)
      .filter((e) => !isSingleEmoji(e.unicode))
      .map((e) => e.unicode);
    expect(rejected).toEqual([]);
  });

  it("accepts the skin-tone variants too, though the picker only offers base emoji", () => {
    const rejected = (compact as { skins?: { unicode: string }[] }[])
      .flatMap((e) => e.skins ?? [])
      .filter((s) => !isSingleEmoji(s.unicode))
      .map((s) => s.unicode);
    expect(rejected).toEqual([]);
  });
});

describe("canonicalEmoji", () => {
  const VS = "\uFE0F";

  it("drops the variation selector after an emoji-style character, so the two spellings are one reaction", () => {
    expect(canonicalEmoji("👍" + VS)).toBe("👍");
    expect(canonicalEmoji("👍")).toBe("👍");
  });

  it("keeps it where it is what makes a text-style character show as an emoji", () => {
    expect(canonicalEmoji("❤" + VS)).toBe("❤" + VS);
    expect(canonicalEmoji("☺" + VS)).toBe("☺" + VS);
  });

  it("leaves sequences alone apart from that, and does not touch plain text", () => {
    expect(canonicalEmoji("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(canonicalEmoji("1" + VS + "⃣")).toBe("1" + VS + "⃣");
    expect(canonicalEmoji("hello")).toBe("hello");
  });

  it("is idempotent, and gives a valid single emoji for everything the picker is built from", () => {
    for (const e of compact as { unicode: string; group?: number }[]) {
      if (e.group === undefined || e.group === 2) continue;
      const once = canonicalEmoji(e.unicode);
      expect(canonicalEmoji(once)).toBe(once);
      expect(isSingleEmoji(once)).toBe(true);
    }
  });
});
