/**
 * What a community's tile (its icon on the rail) is made of when it is not the default: a picture
 * (`iconUrl`), or letters (`iconText`) on a colour (`iconColor`). All three are user data, set by whoever
 * manages the community, and the last two also arrive from other servers inside the community
 * snapshot, so everything here is validated before it is stored or sent on. Pure, so it is unit
 * tested; used by the PATCH route and by applying a snapshot.
 */

export const ICON_TEXT_MAX_CHARACTERS = 3;

// Control characters, line and paragraph separators, and format characters (zero-width joiners
// aside, which emoji need and which are handled by counting whole characters below).
const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
// The only two shapes a stored media URL has: a path under our own uploads (the disk storage driver),
// or an absolute http(s) URL (the S3 driver, or another server's file).
const UPLOADED_PATH = /^\/uploads\/[^\s/][^\s]*$/;
const ABSOLUTE_HTTP_URL = /^https?:\/\/[^\s]+$/i;

function characterCount(text: string): number {
  // Whole characters as a person counts them (an emoji with a skin tone, or a flag, is one), not UTF-16 units.
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(text)].length;
}

/**
 * The letters for a tile, trimmed, or null if the value is not valid (not a string, empty, only
 * spaces, too long, or containing control characters).
 */
export function sanitizeIconText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || UNSAFE_TEXT.test(text)) return null;
  return characterCount(text) <= ICON_TEXT_MAX_CHARACTERS ? text : null;
}

/** "#rrggbb" in lower case, or null if the value is not exactly that. */
export function sanitizeIconColor(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOUR.test(value) ? value.toLowerCase() : null;
}

/** Whether a value can be stored as a community's icon picture. */
export function isIconUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048 && (UPLOADED_PATH.test(value) || ABSOLUTE_HTTP_URL.test(value));
}

/**
 * A picture URL received from another server: only an absolute http(s) URL means anything to us (a
 * path would resolve against OUR server), anything else is dropped.
 */
export function sanitizeRemoteIconUrl(value: unknown): string | null {
  return typeof value === "string" && value.length <= 2048 && ABSOLUTE_HTTP_URL.test(value) ? value : null;
}
