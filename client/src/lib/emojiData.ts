// The Unicode emoji the picker offers, from the open-source emojibase dataset (MIT). It is about
// 80 KB compressed, so it is imported on first use and lands in its own chunk instead of the main
// bundle. Everything is self-hosted: nothing is fetched from a third party.
/**
 * One spelling per emoji, matching the server's canonicalEmoji: the dataset spells "👍" with a
 * trailing variation selector (U+FE0F) that the quick reactions don't have, and without this the
 * two would be different reactions that look identical. The selector is only kept for characters
 * that are text-style by default, like ❤.
 */
export function canonicalEmoji(value: string): string {
  return value.replace(/(\p{Emoji_Presentation})\uFE0F/gu, "$1");
}

export interface EmojiEntry {
  char: string;
  label: string;
  tags: string[];
}

export interface EmojiGroup {
  key: string;
  label: string;
  entries: EmojiEntry[];
}

interface RawEmoji {
  unicode: string;
  label: string;
  tags?: string[];
  group?: number;
}

interface RawGroup {
  key: string;
  message: string;
  order: number;
}

/**
 * Groups the raw dataset for display. Entries without a group (regional-indicator letters) and the
 * "components" group (skin-tone and hair swatches) are not reactions, so they are left out; skin-tone
 * variants of an emoji are not offered separately.
 */
export function buildEmojiGroups(raw: RawEmoji[], groups: RawGroup[]): EmojiGroup[] {
  return groups
    .filter((g) => g.key !== "component")
    .sort((a, b) => a.order - b.order)
    .map((g) => ({
      key: g.key,
      label: g.message.charAt(0).toUpperCase() + g.message.slice(1),
      entries: raw
        .filter((e) => e.group === g.order)
        .map((e) => ({ char: canonicalEmoji(e.unicode), label: e.label, tags: e.tags ?? [] })),
    }))
    .filter((g) => g.entries.length > 0);
}

let cached: Promise<EmojiGroup[]> | null = null;

/** Loads the emoji once; a failed load is not cached, so the next open tries again. */
export function loadEmojiGroups(): Promise<EmojiGroup[]> {
  if (!cached) {
    cached = Promise.all([import("emojibase-data/en/compact.json"), import("emojibase-data/en/messages.json")])
      .then(([compact, messages]) =>
        buildEmojiGroups(compact.default as RawEmoji[], (messages.default as { groups: RawGroup[] }).groups)
      )
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}

/**
 * Entries whose name or tags contain every word of the query, best matches first: a name that starts
 * with the query, then one that has it at a word boundary, then the rest.
 */
export function searchEmoji(groups: EmojiGroup[], query: string): EmojiEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const full = words.join(" ");
  const scored: { entry: EmojiEntry; score: number }[] = [];
  for (const group of groups) {
    for (const entry of group.entries) {
      const label = entry.label.toLowerCase();
      const haystack = [label, ...entry.tags.map((t) => t.toLowerCase())];
      if (!words.every((w) => haystack.some((h) => h.includes(w)))) continue;
      const score = label.startsWith(full) ? 0 : label.includes(` ${full}`) ? 1 : label.includes(full) ? 2 : 3;
      scored.push({ entry, score });
    }
  }
  // Array.prototype.sort is stable, so ties keep the dataset's own order.
  return scored.sort((a, b) => a.score - b.score).map((s) => s.entry);
}
