import { describe, expect, it } from "vitest";
import { buildEmojiGroups, canonicalEmoji, loadEmojiGroups, searchEmoji, type EmojiGroup } from "./emojiData";

const groups = [
  { key: "smileys-emotion", message: "smileys & emotion", order: 0 },
  { key: "component", message: "components", order: 2 },
  { key: "animals-nature", message: "animals & nature", order: 3 },
  { key: "flags", message: "flags", order: 9 },
];

const raw = [
  { unicode: "😀", label: "grinning face", tags: ["face", "grin"], group: 0 },
  { unicode: "😂", label: "face with tears of joy", tags: ["laugh", "tear"], group: 0 },
  { unicode: "🏻", label: "light skin tone", group: 2 },
  { unicode: "🐱", label: "cat face", tags: ["cat", "pet"], group: 3 },
  { unicode: "🇦", label: "regional indicator A" },
];

describe("buildEmojiGroups", () => {
  it("groups by category in order, capitalising the label", () => {
    const built = buildEmojiGroups(raw, groups);
    expect(built.map((g) => g.label)).toEqual(["Smileys & emotion", "Animals & nature"]);
    expect(built[0].entries.map((e) => e.char)).toEqual(["😀", "😂"]);
  });

  it("leaves out skin-tone components, ungrouped entries and empty categories", () => {
    const built = buildEmojiGroups(raw, groups);
    const all = built.flatMap((g) => g.entries.map((e) => e.char));
    expect(all).not.toContain("🏻");
    expect(all).not.toContain("🇦");
    expect(built.some((g) => g.key === "flags")).toBe(false);
  });

  it("copes with an entry that has no tags", () => {
    const built = buildEmojiGroups([{ unicode: "😀", label: "grinning face", group: 0 }], groups);
    expect(built[0].entries[0].tags).toEqual([]);
  });
});

describe("searchEmoji", () => {
  const built: EmojiGroup[] = buildEmojiGroups(raw, groups);

  it("finds by name and by tag, case-insensitively", () => {
    expect(searchEmoji(built, "GRIN").map((e) => e.char)).toEqual(["😀"]);
    expect(searchEmoji(built, "pet").map((e) => e.char)).toEqual(["🐱"]);
  });

  it("needs every word of the query to match", () => {
    expect(searchEmoji(built, "face tear").map((e) => e.char)).toEqual(["😂"]);
    expect(searchEmoji(built, "face dog")).toEqual([]);
  });

  it("puts a name that starts with the query before one that merely contains it", () => {
    // "face" starts "face with tears of joy" but only appears inside "grinning face" and "cat face".
    expect(searchEmoji(built, "face").map((e) => e.char)).toEqual(["😂", "😀", "🐱"]);
  });

  it("returns nothing for a blank query", () => {
    expect(searchEmoji(built, "")).toEqual([]);
    expect(searchEmoji(built, "   ")).toEqual([]);
  });
});

describe("the real dataset", () => {
  it("loads, groups and finds things", async () => {
    const real = await loadEmojiGroups();
    const all = real.flatMap((g) => g.entries.map((e) => e.char));

    expect(real.length).toBeGreaterThanOrEqual(8);
    expect(all.length).toBeGreaterThan(1500);
    expect(all).toContain("😀");
    expect(all).toContain("👨‍👩‍👧‍👦");
    expect(all).not.toContain("🇦"); // a lone regional indicator is not an emoji to react with
    expect(searchEmoji(real, "thumbs up").map((e) => e.char)).toContain("👍");
    expect(searchEmoji(real, "rocket")[0].char).toBe("🚀");
  });

  it("returns the same loaded data on every call", async () => {
    expect(await loadEmojiGroups()).toBe(await loadEmojiGroups());
  });
});

describe("canonicalEmoji", () => {
  const VS = "\uFE0F";

  // The dataset spells thumbs-up with a variation selector; the quick reactions don't. They must be one reaction.
  it("makes the dataset's thumbs-up the same string as the quick reaction", async () => {
    const real = await loadEmojiGroups();
    const all = real.flatMap((g) => g.entries.map((e) => e.char));
    expect(all).toContain("👍");
    expect(all).not.toContain("👍" + VS);
  });

  it("keeps the selector where a text-style character needs it, such as the heart quick reaction", async () => {
    expect(canonicalEmoji("❤" + VS)).toBe("❤" + VS);
    const all = (await loadEmojiGroups()).flatMap((g) => g.entries.map((e) => e.char));
    expect(all).toContain("❤" + VS);
  });
});
