// Property tests (fast-check) for the two functions that cut a stranger's message into pieces to draw (#325, #197, #285): splitLinks (links
// and text) and splitEmoji (emoji and text). The hand-made cases in linkify.test.ts and emojiText.test.ts come from bugs that were found;
// these say what must hold for ANY message, to find the next one. The promise both make is that joining the pieces gives the message back, so
// nothing a person typed is lost or invented, and that a link is only ever a plain web address. A failure prints the seed and the smallest
// message that broke it: add it as an ordinary case in the test file beside the code.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_LARGE_EMOJI, isEmojiGrapheme, isEmojiOnly, splitEmoji } from "./emojiText";
import { splitLinks } from "./linkify";

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const countGraphemes = (text: string) => [...graphemes.segment(text)].length;

// Messages made of the things these functions have to cope with: addresses with brackets and punctuation around them, and the characters that
// must not be able to hide in a link.
const AWKWARD = ["http://", "https://", "HTTPS://", "www.", "awww.", ".com", "example.org", "/path_(x)", "?q=1&r=2", "#frag", "@", ":", "(", ")", "[", "]", "{", "}", ".", ",", "!", "'", '"', "*", "_", "~", " ", "\n", "\t", "‮", "​", "\u0000", " ", "<", ">", "%", "\\", "é", "😀", "xn--", "paypal.com@evil.example", "user:pw@"];
const message = fc.array(fc.oneof(fc.constantFrom(...AWKWARD), fc.string({ maxLength: 6 })), { maxLength: 40 }).map((p) => p.join(""));

describe("splitLinks, for any message", () => {
  it("never throws, and joining the parts gives the message back exactly", () => {
    fc.assert(
      fc.property(fc.oneof(message, fc.fullUnicodeString({ maxLength: 80 })), (text) => {
        const parts = splitLinks(text);
        expect(parts.map((p) => p.text).join("")).toBe(text);
      }),
      { numRuns: 2000 }
    );
  });

  it("has no empty part and never two text parts side by side", () => {
    fc.assert(
      fc.property(message, (text) => {
        const parts = splitLinks(text);
        for (const [i, part] of parts.entries()) {
          expect(part.text).not.toBe("");
          if (part.kind === "text" && i > 0) expect(parts[i - 1].kind).toBe("link");
        }
      }),
      { numRuns: 1000 }
    );
  });

  it("makes a link only of a plain web address: it starts as one, goes where it says, has no credentials, and holds nothing hidden", () => {
    fc.assert(
      fc.property(message, (text) => {
        for (const part of splitLinks(text)) {
          if (part.kind !== "link") continue;
          expect(part.text).toMatch(/^(?:https?:\/\/|www\.)/iu);
          expect(part.text).not.toMatch(UNSAFE);
          expect(part.text).not.toMatch(/[\s<>]/u);
          const target = new URL(part.href);
          expect(target.href).toBe(part.href);
          expect(["http:", "https:"]).toContain(target.protocol);
          expect(target.username + target.password).toBe("");
          expect(target.hostname === "localhost" || target.hostname.includes(".") || target.hostname.startsWith("[")).toBe(true);
          expect(target.hostname.startsWith(".") || target.hostname.endsWith(".")).toBe(false);
        }
      }),
      { numRuns: 2000 }
    );
  });

  it("does not take the sentence punctuation after an address for part of it, nor a bracket the address did not open", () => {
    fc.assert(
      fc.property(message, (text) => {
        for (const part of splitLinks(text)) {
          if (part.kind !== "link") continue;
          expect(".,;:!?'\"*_~").not.toContain(part.text.slice(-1));
          for (const [closer, opener] of [[")", "("], ["]", "["], ["}", "{"]] as const) {
            if (part.text.endsWith(closer)) {
              expect([...part.text].filter((c) => c === closer).length).toBeLessThanOrEqual([...part.text].filter((c) => c === opener).length);
            }
          }
        }
      }),
      { numRuns: 2000 }
    );
  });

  it("finds nothing in a message with no web address in it", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }).filter((s) => !/http|www/iu.test(s)), (text) => {
        const parts = splitLinks(text);
        expect(parts.every((p) => p.kind === "text")).toBe(true);
        expect(parts.length).toBe(text === "" ? 0 : 1);
      }),
      { numRuns: 500 }
    );
  });

  it("finds an address written out in plain text, with a sentence mark after it left outside", () => {
    const host = fc.stringMatching(/^[a-z]{1,10}\.(com|org|net)$/u);
    const path = fc.stringMatching(/^(\/[a-z0-9]{1,8}){0,3}$/u);
    fc.assert(
      fc.property(host, path, fc.constantFrom("http://", "https://", "HTTPS://"), fc.constantFrom("", ".", ",", "!", "?"), fc.constantFrom("", "see ", "hi\n"), (h, p, scheme, mark, before) => {
        const written = `${scheme}${h}${p}`;
        const links = splitLinks(`${before}${written}${mark} done`).filter((part) => part.kind === "link");
        expect(links).toHaveLength(1);
        expect(links[0].text).toBe(written);
      }),
      { numRuns: 500 }
    );
  });
});

const EMOJI = ["😀", "👍🏽", "🇬🇧", "1️⃣", "❤️", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🙂"];
const mixedText = fc.array(fc.oneof(fc.constantFrom(...EMOJI), fc.constantFrom("a", "b c", "©", "™", "#", "*", "7", "é", "—", "\n"), fc.string({ maxLength: 4 })), { maxLength: 30 }).map((p) => p.join(""));

describe("splitEmoji, for any text", () => {
  it("never throws, and joining the pieces gives the text back exactly", () => {
    fc.assert(
      fc.property(fc.oneof(mixedText, fc.fullUnicodeString({ maxLength: 60 })), (text) => {
        expect(splitEmoji(text).map((p) => p.text).join("")).toBe(text);
      }),
      { numRuns: 2000 }
    );
  });

  it("makes each emoji piece one character as a person sees it, and keeps emoji out of the text pieces", () => {
    fc.assert(
      fc.property(mixedText, (text) => {
        const pieces = splitEmoji(text);
        for (const [i, piece] of pieces.entries()) {
          expect(piece.text).not.toBe("");
          if (piece.kind === "emoji") {
            expect(countGraphemes(piece.text)).toBe(1);
            expect(isEmojiGrapheme(piece.text)).toBe(true);
          } else {
            for (const { segment } of graphemes.segment(piece.text)) expect(isEmojiGrapheme(segment)).toBe(false);
            if (i > 0) expect(pieces[i - 1].kind).toBe("emoji"); // runs of text are one piece
          }
        }
      }),
      { numRuns: 1000 }
    );
  });

  it("counts exactly the emoji that were put in, however they sit next to each other and the words", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...EMOJI), { minLength: 0, maxLength: 12 }), fc.constantFrom("", " ", " and "), (emoji, between) => {
        const found = splitEmoji(emoji.join(between)).filter((p) => p.kind === "emoji");
        expect(found.map((p) => p.text)).toEqual(emoji);
      }),
      { numRuns: 500 }
    );
  });

  it("takes plain printable text, digits and symbols such as © and # for text, not for emoji", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme-ascii", maxLength: 60 }), (text) => {
        expect(splitEmoji(text).every((p) => p.kind === "text")).toBe(true);
      }),
      { numRuns: 500 }
    );
  });
});

describe("isEmojiOnly, for any message cut into parts", () => {
  const part = fc.oneof(
    fc.record({ kind: fc.constant("emoji" as const), text: fc.constantFrom(...EMOJI) }),
    fc.record({ kind: fc.constant("emoticon" as const), text: fc.constant(":wave:") }),
    fc.record({ kind: fc.constant("link" as const), text: fc.option(fc.constant("https://example.com"), { nil: undefined }) }),
    fc.record({ kind: fc.constant("text" as const), text: fc.constantFrom("", " ", "  ", "hello", " x ") })
  );

  it("is true only for between one and the most emoji and emoticons, with nothing else but spaces between them", () => {
    fc.assert(
      fc.property(fc.array(part, { maxLength: 16 }), (parts) => {
        const big = parts.filter((p) => p.kind === "emoji" || p.kind === "emoticon").length;
        const somethingElse = parts.some((p) => p.kind === "link" || (p.kind === "text" && p.text.trim() !== ""));
        expect(isEmojiOnly(parts)).toBe(!somethingElse && big >= 1 && big <= MAX_LARGE_EMOJI);
      }),
      { numRuns: 1000 }
    );
  });

  it("is decided by the count at the limit itself, for a message of nothing but emoji, emoticons and spaces", () => {
    const only = fc.oneof(
      fc.record({ kind: fc.constant("emoji" as const), text: fc.constantFrom(...EMOJI) }),
      fc.record({ kind: fc.constant("emoticon" as const), text: fc.constant(":wave:") }),
      fc.record({ kind: fc.constant("text" as const), text: fc.constantFrom("", " ", "  ") })
    );
    fc.assert(
      fc.property(fc.array(only, { maxLength: 16, size: "max" }), (parts) => {
        const big = parts.filter((p) => p.kind !== "text").length;
        expect(isEmojiOnly(parts)).toBe(big >= 1 && big <= MAX_LARGE_EMOJI);
      }),
      { numRuns: 1000 }
    );
  });
});
