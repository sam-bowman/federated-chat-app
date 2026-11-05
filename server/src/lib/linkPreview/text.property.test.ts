// Property tests (fast-check) for the code that reads a stranger's TEXT for link previews (#325, #197): finding addresses in a message, cleaning
// a page's title and description, reading a page's metadata, and checking the list of previews another server sends. The hand-made cases in
// links.test.ts, embed.test.ts and pageMeta.test.ts come from bugs that were found; these say what must hold for ANY input, to find the next
// one. A failure prints the seed and the smallest input that broke it: add that input as an ordinary case in the test file beside the code.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMBED_LIMITS, MAX_EMBEDS, cleanImage, cleanLine, cleanUrl, parseEmbeds, sameEmbeds } from "./embed.js";
import { IMAGE_LIMITS } from "./imageInfo.js";
import { MAX_LINKS_PER_MESSAGE, extractLinks, normalizeAddress } from "./links.js";
import { readPageImageAddress, readPageMeta } from "./pageMeta.js";

// What a line of text from a stranger must never contain once it has been cleaned: controls, format characters (bidi overrides, zero width)
// and line or paragraph separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const points = (text: string) => [...text].length;

// Text that is made of the things these parsers have to deal with: addresses, their brackets and punctuation, tags, entities and the characters
// that must not get through.
const AWKWARD = ["http://", "https://", "HTTPS://", "www.", ".com", "example.org", "/path", "?q=1", "#frag", "@", ":", "(", ")", "[", "]", "{", "}", ".", ",", "!", "'", '"', " ", "\n", "\t", "‮", "​", "\u0000", " ", "<", ">", "&amp;", "&#x41;", "&#0;", "&#xD800;", "&bogus;", "%", "\\", "é", "😀", "xn--", "user:pw@", "paypal.com@evil.example/", "https://u:p@a.example/", "javascript:", "data:"];
const awkward = fc.array(fc.oneof(fc.constantFrom(...AWKWARD), fc.string({ maxLength: 6 })), { maxLength: 40 }).map((p) => p.join(""));

describe("extractLinks, for any text", () => {
  it("never throws, finds no more than the limit, and finds each address once", () => {
    fc.assert(
      fc.property(awkward, fc.integer({ min: 0, max: 6 }), (text, limit) => {
        const found = extractLinks(text, limit);
        expect(found.length).toBeLessThanOrEqual(limit);
        expect(new Set(found).size).toBe(found.length);
      }),
      { numRuns: 1000 }
    );
  });

  it("finds only plain http(s) addresses: parsed, no name and password, a dot in the name, no fragment, short, and ASCII only", () => {
    fc.assert(
      fc.property(awkward, (text) => {
        for (const address of extractLinks(text, 10)) {
          const url = new URL(address);
          expect(url.href).toBe(address);
          expect(["http:", "https:"]).toContain(url.protocol);
          expect(url.username).toBe("");
          expect(url.password).toBe("");
          expect(url.hash).toBe("");
          expect(url.hostname.includes(".") || url.hostname.startsWith("[")).toBe(true);
          expect(address.length).toBeLessThanOrEqual(2048);
          expect(address).toMatch(/^[\x21-\x7e]+$/u); // nothing a person could not see, nothing from another script
        }
      }),
      { numRuns: 1000 }
    );
  });

  it("finds the same addresses in the same text every time, and a longer limit only adds to the end", () => {
    fc.assert(
      fc.property(awkward, (text) => {
        const three = extractLinks(text);
        expect(extractLinks(text)).toEqual(three);
        expect(three.length).toBeLessThanOrEqual(MAX_LINKS_PER_MESSAGE);
        expect(extractLinks(text, 10).slice(0, three.length)).toEqual(three);
      }),
      { numRuns: 500 }
    );
  });

  it("finds an address that is written out in plain text, at the front of any text that cannot run into it", () => {
    const host = fc.stringMatching(/^[a-z]{1,10}\.(com|org|net)$/u);
    const path = fc.stringMatching(/^(\/[a-z0-9]{0,8}){0,3}$/u);
    fc.assert(
      fc.property(host, path, fc.constantFrom("http://", "https://", "HTTP://"), fc.constantFrom("", " and more", "\nnext line"), (h, p, scheme, after) => {
        const written = `${scheme}${h}${p}`;
        const found = extractLinks(`${written}${after}`);
        expect(found[0]).toBe(new URL(written).href.replace(/#.*$/u, ""));
      }),
      { numRuns: 300 }
    );
  });
});

describe("normalizeAddress, for any text", () => {
  it("never throws, and is idempotent: an address that comes out comes out the same again", () => {
    fc.assert(
      fc.property(awkward, (text) => {
        const once = normalizeAddress(text);
        if (once !== null) expect(normalizeAddress(once)).toBe(once);
      }),
      { numRuns: 1000 }
    );
  });
});

describe("cleanLine and cleanUrl, for any value", () => {
  it("make a line that is short, has nothing hidden in it, and is already clean", () => {
    fc.assert(
      fc.property(fc.oneof(awkward, fc.string({ maxLength: 300 }), fc.string({ unit: "binary", maxLength: 100 })), fc.integer({ min: 2, max: 80 }), (text, max) => {
        const line = cleanLine(text, max);
        if (line === null) return;
        expect(points(line)).toBeLessThanOrEqual(max);
        expect(line).not.toMatch(UNSAFE);
        expect(line).toBe(line.trim());
        expect(line).not.toMatch(/\s{2}|[\n\t\r]/u);
        expect(cleanLine(line, max)).toBe(line); // cleaning twice changes nothing
      }),
      { numRuns: 1000 }
    );
  });

  it("make nothing of what is not text", () => {
    fc.assert(
      fc.property(fc.anything().filter((v) => typeof v !== "string"), (value) => {
        expect(cleanLine(value, 20)).toBeNull();
        expect(cleanUrl(value)).toBeNull();
      }),
      { numRuns: 300 }
    );
  });

  it("make an address that is parsed, plain http(s), without credentials, and unchanged by cleaning again", () => {
    fc.assert(
      fc.property(fc.oneof(fc.webUrl(), awkward, fc.string()), (text) => {
        const url = cleanUrl(text);
        if (url === null) return;
        const parsed = new URL(url);
        expect(parsed.href).toBe(url);
        expect(["http:", "https:"]).toContain(parsed.protocol);
        expect(parsed.username + parsed.password).toBe("");
        expect(cleanUrl(url)).toBe(url);
      }),
      { numRuns: 1000 }
    );
  });
});

// An embed as another server might send it: right, wrong, or hostile in each field.
const anyValue = fc.oneof(fc.string(), fc.constant(null), fc.integer(), fc.double(), fc.boolean(), fc.jsonValue());
const addressLike = fc.oneof(fc.webUrl(), awkward, fc.constantFrom("javascript:alert(1)", "https://u:p@x.example/", "/relative", "data:text/html,x"));
const imageLike = fc.oneof(
  anyValue,
  fc.record({ url: addressLike, width: fc.oneof(fc.integer({ min: -3, max: 5000 }), fc.double(), fc.string()), height: fc.oneof(fc.integer({ min: -3, max: 5000 }), fc.double(), fc.string()), extra: anyValue }, { requiredKeys: ["url"] })
);
const embedLike = fc.oneof(
  anyValue,
  fc.record({ url: addressLike, title: anyValue, description: anyValue, siteName: anyValue, image: imageLike, html: anyValue }, { requiredKeys: [] })
);

// Previews that are mostly good, from a small pool of addresses, so that the list limit and repeated addresses really come up.
const goodish = fc.record({ url: fc.constantFrom("https://a.example/1", "https://a.example/2", "https://b.example/", "http://c.example/x", "https://d.example/"), title: fc.constantFrom("A", "B", "  ", "C"), description: fc.option(fc.constantFrom("d", ""), { nil: undefined }) });

describe("parseEmbeds, for lists that are mostly good", () => {
  it("keeps no more than the limit, in order, and each address once", () => {
    fc.assert(
      fc.property(fc.array(goodish, { maxLength: 12 }), (sent) => {
        const out = parseEmbeds(sent);
        expect(out.length).toBeLessThanOrEqual(MAX_EMBEDS);
        expect(new Set(out.map((e) => e.url)).size).toBe(out.length);
        // What is kept is the first of each address that had anything to show, in the order sent.
        const expected: string[] = [];
        for (const item of sent) {
          const shows = cleanLine(item.title, EMBED_LIMITS.title) !== null || cleanLine(item.description, EMBED_LIMITS.description) !== null;
          if (shows && !expected.includes(item.url) && expected.length < MAX_EMBEDS) expected.push(item.url);
        }
        expect(out.map((e) => e.url)).toEqual(expected);
      }),
      { numRuns: 1000 }
    );
  });
});

describe("parseEmbeds, for any list another server could send", () => {
  it("never throws, and keeps only what a card is allowed to show", () => {
    fc.assert(
      fc.property(fc.oneof(anyValue, fc.array(embedLike, { maxLength: 8 })), (sent) => {
        const out = parseEmbeds(sent);
        expect(Array.isArray(out)).toBe(true);
        expect(out.length).toBeLessThanOrEqual(MAX_EMBEDS);
        expect(new Set(out.map((e) => e.url)).size).toBe(out.length);
        for (const embed of out) {
          expect(Object.keys(embed).every((key) => ["url", "title", "description", "siteName", "image"].includes(key))).toBe(true);
          expect(cleanUrl(embed.url)).toBe(embed.url);
          expect(embed.title === null || cleanLine(embed.title, EMBED_LIMITS.title) === embed.title).toBe(true);
          expect(embed.description === null || cleanLine(embed.description, EMBED_LIMITS.description) === embed.description).toBe(true);
          expect(embed.siteName === null || cleanLine(embed.siteName, EMBED_LIMITS.siteName) === embed.siteName).toBe(true);
          // Something to show: words, or a picture.
          expect(embed.title !== null || embed.description !== null || embed.image !== undefined).toBe(true);
          if (embed.image) {
            expect(Object.keys(embed.image).sort()).toEqual(["height", "url", "width"]);
            expect(cleanUrl(embed.image.url)).toBe(embed.image.url);
            expect(Number.isInteger(embed.image.width) && Number.isInteger(embed.image.height)).toBe(true);
            expect(embed.image.width).toBeGreaterThanOrEqual(1);
            expect(embed.image.height).toBeGreaterThanOrEqual(1);
            expect(embed.image.width).toBeLessThanOrEqual(IMAGE_LIMITS.maxSide);
            expect(embed.image.height).toBeLessThanOrEqual(IMAGE_LIMITS.maxSide);
            expect(embed.image.width * embed.image.height).toBeLessThanOrEqual(IMAGE_LIMITS.maxPixels);
          }
        }
      }),
      { numRuns: 1000 }
    );
  });

  it("gives the same list when it is checked again (what is kept is already clean), and two checks compare equal", () => {
    fc.assert(
      fc.property(fc.array(embedLike, { maxLength: 8 }), (sent) => {
        const once = parseEmbeds(sent);
        const twice = parseEmbeds(once);
        expect(twice).toEqual(once);
        expect(sameEmbeds(once, twice)).toBe(true);
      }),
      { numRuns: 1000 }
    );
  });

  it("cleans a picture reference to nothing or to exactly three fields", () => {
    fc.assert(
      fc.property(imageLike, (image) => {
        const clean = cleanImage(image);
        if (clean === null) return;
        expect(Object.keys(clean).sort()).toEqual(["height", "url", "width"]);
        expect(cleanImage(clean)).toEqual(clean);
      }),
      { numRuns: 1000 }
    );
  });
});

// A web page as a hostile site could write it: tags, attributes, entities and quotes in any order, cut off anywhere.
const PAGE_BITS = ["<html>", "<head>", "</head>", "<title>", "</title>", "<meta ", 'property="og:title" ', 'name="description" ', 'property="og:image" ', 'name="twitter:image" ', 'property="og:site_name" ', "content=", '"', "'", "Hello", " ", ">", "/>", "&amp;", "&lt;", "&#x27;", "&#0;", "&#xD800;", "&#99999999;", "&bogus;", "javascript:alert(1)", "https://cdn.example.com/a.png", "/rel/a.png", "‮", "\u0000", "\n", "<!--", "-->", "<", "="];
const pageLike = fc.array(fc.oneof(fc.constantFrom(...PAGE_BITS), fc.string({ maxLength: 8 })), { maxLength: 60 }).map((p) => p.join(""));

describe("readPageMeta and readPageImageAddress, for any page", () => {
  it("never throw, and give only clean lines and a clean address", () => {
    fc.assert(
      fc.property(pageLike, fc.constantFrom("https://www.example.com/blog/post", "http://127.0.0.1:8080/", "https://xn--e1afmkfd.xn--p1ai/a/b?c=d"), (html, at) => {
        const meta = readPageMeta(html, at);
        expect(meta.title === null || cleanLine(meta.title, EMBED_LIMITS.title) === meta.title).toBe(true);
        expect(meta.description === null || cleanLine(meta.description, EMBED_LIMITS.description) === meta.description).toBe(true);
        expect(meta.siteName === null || cleanLine(meta.siteName, EMBED_LIMITS.siteName) === meta.siteName).toBe(true);
        const picture = readPageImageAddress(html, at);
        expect(picture === null || cleanUrl(picture) === picture).toBe(true);
      }),
      { numRuns: 1000 }
    );
  });

  it("give a picture address only from a tag that names a plain web address, however the page spells it", () => {
    const value = fc.oneof(awkward, fc.constantFrom("javascript:alert(1)", "data:image/png;base64,AAAA", "https://u:p@cdn.example.com/a.png", "//cdn.example.com/a.png", "/a.png", "a.png", "../a.png", "https://cdn.example.com/a b.png", "HTTP://CDN.EXAMPLE.COM/A.png"));
    fc.assert(
      fc.property(value, fc.constantFrom("og:image", "og:image:secure_url", "twitter:image"), (content, key) => {
        const quoted = content.replace(/"/gu, "&quot;");
        const picture = readPageImageAddress(`<head><meta property="${key}" content="${quoted}"></head>`, "https://www.example.com/blog/post");
        if (picture === null) return;
        const url = new URL(picture);
        expect(["http:", "https:"]).toContain(url.protocol);
        expect(url.username + url.password).toBe("");
        expect(cleanUrl(picture)).toBe(picture);
      }),
      { numRuns: 1000 }
    );
  });

  it("give what a page says in a title as text and never as a tag that survives", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (inner) => {
        const meta = readPageMeta(`<head><title>${inner}</title></head>`, "https://example.com/");
        if (meta.title !== null) expect(meta.title).not.toMatch(UNSAFE);
      }),
      { numRuns: 500 }
    );
  });
});
