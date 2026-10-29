// Finds the Unicode emoji in a piece of text, so a message can draw them larger than the words around them (#285) and tell a message
// that is ONLY emoji from one that merely has some. A message is a stranger's text: this only reads it, never builds markup from it.

export type EmojiPiece = { kind: "text" | "emoji"; text: string };

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// An emoji by its own look, not by being in the emoji tables: `©`, `™` and a bare digit are in them but are ordinary characters.
// What makes one an emoji is being drawn as a picture by default (Emoji_Presentation: faces, flags, most symbols), or being asked to be
// (U+FE0F after a character that has a picture form, as in `©️` or `❤️`), or being a keycap (`1️⃣`, U+20E3).
const DRAWN_AS_PICTURE = /\p{Emoji_Presentation}/u;
const ASKED_FOR_PICTURE = /\p{Extended_Pictographic}[\u{FE0F}\u{200D}]|️/u;
const KEYCAP = /⃣/u;

/** Whether one grapheme (what a person sees as a single character) is an emoji. */
export function isEmojiGrapheme(grapheme: string): boolean {
  return DRAWN_AS_PICTURE.test(grapheme) || KEYCAP.test(grapheme) || (ASKED_FOR_PICTURE.test(grapheme) && /\p{Extended_Pictographic}/u.test(grapheme));
}

/**
 * The text cut into runs of plain text and single emoji, in order, so that joining every `text` gives back the input. A skin tone, a
 * flag, a family joined with zero-width joiners and a keycap are each ONE emoji (the browser's own idea of a character decides).
 */
export function splitEmoji(text: string): EmojiPiece[] {
  const pieces: EmojiPiece[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const kind = isEmojiGrapheme(segment) ? "emoji" : "text";
    const last = pieces[pieces.length - 1];
    if (kind === "text" && last?.kind === "text") last.text += segment;
    else pieces.push({ kind, text: segment });
  }
  return pieces;
}

/** The most emoji (and emoticons) a message can hold and still be shown large: a wall of them is a different message. */
export const MAX_LARGE_EMOJI = 10;

/**
 * Whether a message, cut into its parts, is nothing but a few emoji and emoticons (and spaces between them): then they are drawn large
 * (#285). A word, a link, or a `:trigger:` that is not an emoticon here is text, so it is not; and more than a handful is a different
 * kind of message.
 */
export function isEmojiOnly(parts: { kind: "link" | "emoticon" | "emoji" | "text"; text?: string }[]): boolean {
  let count = 0;
  for (const part of parts) {
    if (part.kind === "emoji" || part.kind === "emoticon") count++;
    else if (part.kind === "link" || (part.text ?? "").trim() !== "") return false;
  }
  return count >= 1 && count <= MAX_LARGE_EMOJI;
}
