// Finding web addresses in a message (#197). The text is what somebody else typed, so this is deliberately narrow:
// only http(s) addresses, and `www.` ones (taken as https), ever become links, and the link goes where its text says.

export type MessagePart = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

// A candidate starts at `http://`, `https://` or `www.`, and runs to the next whitespace, angle bracket or control, format or
// separator character (\p{Cc}, \p{Cf}, \p{Zl}, \p{Zp}: a link must not hide a bidirectional override or a zero-width character,
// which can make an address read as another one).
// `www.` is only a start when it is not the tail of something else (`awww.`, `foo.www.`, an e-mail address, a path).
const CANDIDATE =
  /(?<![\w@./-])(?:https?:\/\/|www\.)[^\s<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/giu;

// What often follows an address in a sentence without being part of it.
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*", "_", "~"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Drops the sentence punctuation after an address, and a closing bracket the address did not open (so
 * `(https://x.example/a)` loses its `)` but `https://en.example.org/wiki/Thing_(disambiguation)` keeps its own).
 * One pass from the end with counts taken once: a long run of look-alike characters must not cost more than its length.
 */
function trimTrailing(candidate: string): string {
  const balance = new Map<string, number>();
  for (const c of candidate) {
    if (c in CLOSERS) balance.set(c, (balance.get(c) ?? 0) + 1);
    else if (Object.values(CLOSERS).includes(c)) balance.set(c, (balance.get(c) ?? 0) - 1);
  }
  let end = candidate.length;
  while (end > 0) {
    const c = candidate[end - 1];
    if (TRAILING.has(c)) {
      end--;
    } else if (c in CLOSERS && (balance.get(c) ?? 0) + (balance.get(CLOSERS[c]) ?? 0) > 0) {
      // More of this closer than of its opener, counting the opener as negative: this one has nothing to close.
      balance.set(c, (balance.get(c) ?? 0) - 1);
      end--;
    } else {
      break;
    }
  }
  return candidate.slice(0, end);
}

/** The address a candidate leads to, or null if it is not a plain http(s) address a person could be sent to. */
function destination(text: string): string | null {
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  // Defence in depth: what reaches here already starts with http(s):// or www., so this cannot fire today. It is the line that
  // keeps `javascript:`, `data:` and the like from ever being a link if the pattern above is widened.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `https://paypal.com@evil.example` reads as one site and goes to another: not a link.
  if (url.username || url.password) return null;
  if (!url.hostname || url.hostname.startsWith(".") || url.hostname.endsWith(".")) return null;
  // A bare word is not an address (`https://x`): there has to be a dot, or `localhost`, or an address in brackets.
  if (!url.hostname.includes(".") && url.hostname !== "localhost" && !url.hostname.startsWith("[")) return null;
  return url.href;
}

/** Splits a message into plain text and links, in order. Joining the parts' `text` gives the original message back. */
export function splitLinks(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const match of content.matchAll(CANDIDATE)) {
    const text = trimTrailing(match[0]);
    const href = text ? destination(text) : null;
    if (!href) continue;
    const start = match.index ?? 0;
    if (start > last) parts.push({ kind: "text", text: content.slice(last, start) });
    parts.push({ kind: "link", text, href });
    last = start + text.length;
  }
  if (last < content.length) parts.push({ kind: "text", text: content.slice(last) });
  return parts;
}
