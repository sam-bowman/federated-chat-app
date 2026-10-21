// Which addresses in a message may get a preview (#197). The text is a stranger's, so this is as narrow as the client's own link
// detection (client/src/lib/linkify.ts): only `http://`, `https://` and `www.` start one, the address always goes where it says,
// nothing with a name and password in it, and a control, format or separator character ends it so it cannot hide in one.
// Kept free of config.ts imports so it can be unit-tested on its own.

/** Most previews one message gets, and so the most pages one message can make the server read. */
export const MAX_LINKS_PER_MESSAGE = 3;
const MAX_ADDRESS_LENGTH = 2048;

/** Starts of an address in running text: a scheme, or `www.`. Case does not matter (HTTPS://X is the same address). */
const START = /(?:https?:\/\/|www\.)/giu;
/** What ends an address: whitespace, a control, format or separator character, or a character no address contains. */
const STOP = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>"`\\^{}|]/u;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[" };

/** Cuts a candidate where it stops being an address: trailing punctuation, and a closing bracket nothing in it opened. */
function trimEnd(candidate: string): string {
  let text = candidate;
  for (;;) {
    const last = text[text.length - 1];
    if (last === undefined) return text;
    if (TRAILING.has(last)) {
      text = text.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener) {
      const opens = [...text].filter((c) => c === opener).length;
      const closes = [...text].filter((c) => c === last).length;
      if (closes > opens) {
        text = text.slice(0, -1);
        continue;
      }
    }
    return text;
  }
}

/** The address as a normalised http(s) URL string, or null if it is not one worth reading: credentials, no dot in the host, too long. */
export function normalizeAddress(candidate: string): string | null {
  if (candidate.length > MAX_ADDRESS_LENGTH) return null;
  const withScheme = /^www\./iu.test(candidate) ? `https://${candidate}` : candidate;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  // A name with a dot (or an address): "http://intranet" is not a public page, and "localhost" is never worth reading.
  if (!url.hostname.includes(".") && !url.hostname.startsWith("[")) return null;
  url.hash = ""; // a fragment is not part of the page
  const href = url.href;
  return href.length <= MAX_ADDRESS_LENGTH ? href : null;
}

/**
 * The distinct addresses in a message, in the order they appear, at most `limit`. Work is bounded by the text: one pass over it,
 * each candidate cut at the first character that cannot be in an address.
 */
export function extractLinks(text: string, limit = MAX_LINKS_PER_MESSAGE): string[] {
  const found: string[] = [];
  const start = new RegExp(START.source, START.flags); // its own position, so two calls never share one
  for (let match = start.exec(text); match && found.length < limit; match = start.exec(text)) {
    const at = match.index;
    // `www.` in the middle of a word ("awww.example") is not the start of an address.
    if (/^www\./iu.test(match[0]) && at > 0 && /[\p{L}\p{N}]/u.test(text[at - 1])) continue;
    // Never read further than an address can be long, and carry on from where this one ended: every character is looked at once.
    const limitEnd = Math.min(text.length, at + MAX_ADDRESS_LENGTH + 1);
    let end = at;
    while (end < limitEnd && !STOP.test(text[end])) end++;
    start.lastIndex = Math.max(end, at + 1);
    const address = normalizeAddress(trimEnd(text.slice(at, end)));
    if (address && !found.includes(address)) found.push(address);
  }
  return found;
}
