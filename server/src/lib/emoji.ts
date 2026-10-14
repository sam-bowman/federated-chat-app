// What counts as "an emoji" for a reaction. A reaction used to be any 1-32 character string, so the
// API would take "hello" as one. Now it has to be exactly one emoji: a single user-perceived
// character (grapheme cluster) that is an emoji, which covers ZWJ sequences (family, profession),
// skin tones, flags, keycaps and subdivision flags, while rejecting plain text, several emoji
// and emoji mixed with text.

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

// Flag: two regional indicators. Keycap: [0-9#*], optional VS16, U+20E3.
// Everything else: pictographs, skin-tone modifiers, VS16, ZWJ and tag characters (subdivision flags),
// which must include at least one pictograph (checked separately, so VS16/ZWJ alone don't pass).
const SINGLE_EMOJI = /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\u{E0020}-\u{E007F}]+)$/u;
const HAS_PICTOGRAPH = /\p{Extended_Pictographic}|^\p{Regional_Indicator}|\u20E3/u;

export function isSingleEmoji(value: string): boolean {
  if (value.length === 0 || value.length > 32) return false;
  const segments = [...segmenter.segment(value)];
  if (segments.length !== 1) return false;
  return SINGLE_EMOJI.test(value) && HAS_PICTOGRAPH.test(value);
}

/**
 * One spelling per emoji. Many emoji exist both with and without a trailing variation selector
 * (U+FE0F): "👍" and "👍\uFE0F" look identical, but are different strings, so two clients could
 * make two "different" reactions that render the same. The selector only matters for characters
 * that are text-style by default (❤ needs it to show as ❤\uFE0F), so drop it after the ones that are
 * already emoji-style and leave the others alone. Idempotent.
 */
export function canonicalEmoji(value: string): string {
  return value.replace(/(\p{Emoji_Presentation})\uFE0F/gu, "$1");
}

/** Distinct reactions allowed on one message, so it can't be flooded with them. */
export const MAX_DISTINCT_REACTIONS = 20;
