import { describe, expect, it } from "vitest";
import { isEmojiGrapheme, splitEmoji } from "./emojiText";

const kinds = (text: string) => splitEmoji(text).map((p) => `${p.kind}:${p.text}`);

describe("what counts as an emoji", () => {
  it.each([
    ["a face", "😀"],
    ["a skin tone", "👍🏽"],
    ["a flag (two regional indicators)", "🇬🇧"],
    ["a family joined with zero-width joiners", "👨‍👩‍👧‍👦"],
    ["a heart asked for as a picture (U+FE0F)", "❤️"],
    ["a keycap", "1️⃣"],
    ["copyright asked for as a picture", "©️"],
    ["a symbol drawn as a picture by default", "⭐"],
  ])("%s is one emoji", (_name, text) => {
    expect(isEmojiGrapheme(text)).toBe(true);
    expect(splitEmoji(text)).toEqual([{ kind: "emoji", text }]);
  });

  it.each([
    ["a letter", "a"],
    ["a digit", "7"],
    ["a hash sign", "#"],
    ["copyright as text", "©"],
    ["trade mark as text", "™"],
    ["a registered sign", "®"],
    ["an ordinary punctuation mark", "!"],
    ["a space", " "],
    ["a CJK character", "漢"],
  ])("%s is not", (_name, text) => {
    expect(isEmojiGrapheme(text)).toBe(false);
  });
});

describe("cutting a text into runs of words and emoji", () => {
  it("keeps the words and the emoji in order, and joining the runs gives the text back", () => {
    const text = "good morning 😀 see you at 5:30 👍🏽 bye";
    const pieces = splitEmoji(text);
    expect(pieces.map((p) => p.text).join("")).toBe(text);
    expect(kinds(text)).toEqual(["text:good morning ", "emoji:😀", "text: see you at 5:30 ", "emoji:👍🏽", "text: bye"]);
  });

  it("makes one run of emoji next to each other into separate emoji, not one", () => {
    expect(kinds("😀😀🇬🇧")).toEqual(["emoji:😀", "emoji:😀", "emoji:🇬🇧"]);
  });

  it("does not turn digits, brackets or a time into emoji", () => {
    expect(kinds("10:30 (ok) #1 © 2026™")).toEqual(["text:10:30 (ok) #1 © 2026™"]);
  });

  it("reads nothing as an emoji in an address or a trigger", () => {
    expect(kinds("https://example.com/a:b:c :party:")).toEqual(["text:https://example.com/a:b:c :party:"]);
  });

  it("is empty for an empty text", () => {
    expect(splitEmoji("")).toEqual([]);
  });
});
