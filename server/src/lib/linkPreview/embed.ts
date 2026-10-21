// A link preview, as it is kept, sent and shown (#197). Everything in one is a STRANGER'S text (the linked page's, or what another
// server says the page said), so it is never trusted as it comes: it is cut to a plain line of text of a fixed length, and anything
// that is not a plain http(s) address is dropped. This runs on what this server read itself, on what is stored, and on what
// another server sends, so all three agree.
// Kept free of config.ts imports so it can be unit-tested on its own.

export interface Embed {
  /** The page's address, as the author's server read it (an absolute http(s) address, no credentials). */
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
}

/** A message never shows more than this many previews. */
export const MAX_EMBEDS = 3;
export const EMBED_LIMITS = { url: 2048, title: 150, description: 300, siteName: 60 } as const;

/** A character that is not part of readable text: controls, format characters (bidi overrides, zero width) and line separators. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const HAS_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * One line of plain text of at most `max` characters, or null if there is nothing left. Whitespace runs become one space; controls,
 * format characters and separators are removed (they can hide or reorder text); too long is cut and ends with an ellipsis.
 */
export function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Bounded first, so a huge string is not walked: a line this long is cut anyway.
  const text = value.slice(0, max * 8).replace(/\s+/gu, " ").replace(UNSAFE, "").replace(/\s+/gu, " ").trim();
  if (text === "") return null;
  const characters = [...text];
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join("").trimEnd()}…`;
}

/** An absolute http(s) address with no name and password in it, or null. */
export function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > EMBED_LIMITS.url || HAS_UNSAFE.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href.length <= EMBED_LIMITS.url ? url.href : null;
}

/**
 * Whatever was stored, or another server sent, as the previews it is allowed to be: an array (no more than MAX_EMBEDS) of objects,
 * each with a good address and at least a title or a description, other fields cut to length, anything else dropped. Never throws.
 */
export function parseEmbeds(value: unknown): Embed[] {
  if (!Array.isArray(value)) return [];
  const out: Embed[] = [];
  for (const item of value) {
    if (out.length >= MAX_EMBEDS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const url = cleanUrl(record.url);
    if (!url || out.some((e) => e.url === url)) continue;
    const title = cleanLine(record.title, EMBED_LIMITS.title);
    const description = cleanLine(record.description, EMBED_LIMITS.description);
    if (title === null && description === null) continue;
    out.push({ url, title, description, siteName: cleanLine(record.siteName, EMBED_LIMITS.siteName) });
  }
  return out;
}

/** Two lists of previews say the same thing (same addresses, same text). */
export function sameEmbeds(a: Embed[], b: Embed[]): boolean {
  return a.length === b.length && a.every((e, i) => e.url === b[i].url && e.title === b[i].title && e.description === b[i].description && e.siteName === b[i].siteName);
}
