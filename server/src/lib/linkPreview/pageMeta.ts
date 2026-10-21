// Reads the few things a link preview shows (a title, a description, a site name) from the start of a page (#197). The page is a
// stranger's: nothing in it is run, nothing is followed, and what is read is only ever text that goes through cleanLine. It is not a
// full HTML parser on purpose: it looks for a handful of tags by scanning, with every step bounded by the length of the text, so
// a hostile page cannot make it slow.
// Kept free of config.ts imports so it can be unit-tested on its own.
import { EMBED_LIMITS, cleanLine } from "./embed.js";

export interface PageMeta {
  title: string | null;
  description: string | null;
  siteName: string | null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };

/** Turns `&amp;`, `&#39;` and `&#x27;` back into characters (and leaves anything it does not know as it is). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/giu, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

const MAX_TAG_LENGTH = 4000;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;

/** The attributes of one tag as a map (names in lower case, first one wins). */
function attributesOf(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of tag.matchAll(ATTRIBUTE)) {
    const name = m[1].toLowerCase();
    if (!found.has(name)) found.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return found;
}

/** Each `<meta ...>` tag's attributes, up to the end of `<head>` (or the whole text if there is none). */
function metaTags(html: string): Map<string, string>[] {
  const lower = html.toLowerCase();
  const headEnd = lower.indexOf("</head");
  const end = headEnd === -1 ? html.length : headEnd;
  const tags: Map<string, string>[] = [];
  let at = 0;
  while (tags.length < 200) {
    const open = lower.indexOf("<meta", at);
    if (open === -1 || open >= end) break;
    const close = lower.indexOf(">", open);
    if (close === -1) break;
    at = close + 1;
    if (close - open <= MAX_TAG_LENGTH) tags.push(attributesOf(html.slice(open + 5, close)));
  }
  return tags;
}

/** The text of `<title>`, or null. */
function titleTag(html: string): string | null {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  if (open === -1) return null;
  const start = lower.indexOf(">", open);
  const end = start === -1 ? -1 : lower.indexOf("</title", start);
  if (start === -1 || end === -1 || end - start > MAX_TAG_LENGTH) return null;
  return decodeEntities(html.slice(start + 1, end).replace(/<[^>]*>/gu, ""));
}

/** The host to show when a page names no site: `www.` taken off. */
export function hostLabel(pageUrl: string): string | null {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./iu, "") || null;
  } catch {
    return null;
  }
}

/** What to show for a page. The title is the page's own (Open Graph first, then Twitter's, then `<title>`); the site name is its own or its host. */
export function readPageMeta(html: string, pageUrl: string): PageMeta {
  const meta = new Map<string, string>();
  for (const tag of metaTags(html)) {
    const key = (tag.get("property") ?? tag.get("name") ?? "").toLowerCase();
    const content = tag.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v !== undefined && v.trim() !== "");
  return {
    title: cleanLine(first("og:title", "twitter:title") ?? titleTag(html), EMBED_LIMITS.title),
    description: cleanLine(first("og:description", "twitter:description", "description"), EMBED_LIMITS.description),
    siteName: cleanLine(first("og:site_name") ?? hostLabel(pageUrl), EMBED_LIMITS.siteName),
  };
}
