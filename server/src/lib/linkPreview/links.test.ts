import { describe, expect, it } from "vitest";
import { MAX_LINKS_PER_MESSAGE, extractLinks, normalizeAddress } from "./links.js";

describe("the addresses in a message", () => {
  it("finds an http or https address, and one that starts with www. (taken as https)", () => {
    expect(extractLinks("see https://example.com/a and http://example.org and www.example.net/x")).toEqual([
      "https://example.com/a",
      "http://example.org/",
      "https://www.example.net/x",
    ]);
  });

  it("keeps a port, a path, a query, and drops the fragment (which is not part of the page)", () => {
    expect(extractLinks("https://example.com:8443/a/b?x=1&y=2#top")).toEqual(["https://example.com:8443/a/b?x=1&y=2"]);
  });

  it("leaves trailing punctuation out, and a closing bracket nothing in the address opened", () => {
    expect(extractLinks("(see https://example.com/a).")).toEqual(["https://example.com/a"]);
    expect(extractLinks("https://example.com/a, https://example.com/b! https://example.com/c?")).toEqual(["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
    // A bracket that belongs to the address stays.
    expect(extractLinks("https://en.example.org/wiki/Thing_(film)")).toEqual(["https://en.example.org/wiki/Thing_(film)"]);
  });

  it("ignores every other scheme, however it is written", () => {
    for (const text of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "ftp://example.com/x", "mailto:a@example.com", "vbscript:x", "//example.com/x", "JaVaScRiPt:alert(1)"]) {
      expect(extractLinks(text), text).toEqual([]);
    }
  });

  it("takes the scheme in any case, as an address is", () => {
    expect(extractLinks("HTTPS://EXAMPLE.COM/Path")).toEqual(["https://example.com/Path"]);
  });

  it("never takes an address with a name and password in it, which can pass for another site", () => {
    expect(extractLinks("https://paypal.com@evil.example/login")).toEqual([]);
    expect(extractLinks("http://user:secret@example.com/")).toEqual([]);
  });

  it("stops at a control, bidi or zero-width character instead of hiding one inside the address", () => {
    expect(extractLinks("https://example.com/a‮evil")).toEqual(["https://example.com/a"]);
    expect(extractLinks("https://exam​ple.com/x")).toEqual([]); // the host is cut at "exam", which has no dot
    expect(extractLinks("https://example.com/a\u0000b")).toEqual(["https://example.com/a"]);
  });

  it("leaves alone what only looks like one", () => {
    for (const text of ["it is 10:30", "version v1.2.3", ":party: time", "awww.example.com", "https://", "www.", "https:// example.com"]) {
      expect(extractLinks(text), text).toEqual([]);
    }
  });

  it("does not read a name with no dot (an office machine, localhost) as a page on the web", () => {
    expect(extractLinks("http://intranet/ and http://localhost/x and https://printer/")).toEqual([]);
    expect(normalizeAddress("http://localhost:3000/")).toBeNull();
  });

  it("finds the same page once, and no more than the limit", () => {
    expect(extractLinks("https://example.com/a https://example.com/a#x https://EXAMPLE.com/a")).toEqual(["https://example.com/a"]);
    const many = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`).join(" ");
    expect(extractLinks(many)).toHaveLength(MAX_LINKS_PER_MESSAGE);
    expect(extractLinks(many, 5)).toHaveLength(5);
  });

  it("ignores an address that is too long to be sensible", () => {
    expect(extractLinks(`https://example.com/${"a".repeat(3000)}`)).toEqual([]);
  });

  it("costs no more than the length of the text, whatever it is made of", () => {
    const hostile = ["https://".repeat(20000), "http://a.b/".repeat(5000), `https://example.com/${")".repeat(50000)}`, `www.${"a.".repeat(30000)}`, "(".repeat(50000) + "https://example.com/"];
    for (const text of hostile) {
      const start = performance.now();
      extractLinks(text);
      expect(performance.now() - start, text.slice(0, 30)).toBeLessThan(500);
    }
  });
});
