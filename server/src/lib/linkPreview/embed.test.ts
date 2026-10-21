import { describe, expect, it } from "vitest";
import { EMBED_LIMITS, MAX_EMBEDS, cleanLine, cleanUrl, parseEmbeds, sameEmbeds } from "./embed.js";

describe("a line of text from a stranger", () => {
  it("is one line: runs of whitespace become one space, and the ends are trimmed", () => {
    expect(cleanLine("  Hello \n\t world  ", 50)).toBe("Hello world");
  });

  it("loses what can hide or reorder text: controls, bidi overrides, zero-width characters, line separators", () => {
    expect(cleanLine("pay‮pal​.com\u0000 x", 50)).toBe("paypal.com x");
  });

  it("is cut to the length with an ellipsis, counting characters and not code units", () => {
    expect(cleanLine("a".repeat(500), 10)).toBe("aaaaaaaaa…");
    expect([...cleanLine("😀".repeat(100), 10)!]).toHaveLength(10);
  });

  it("is null when nothing readable is left, or it is not text", () => {
    for (const value of ["", "   ", "​​", null, undefined, 5, {}, ["x"]]) expect(cleanLine(value, 10), String(value)).toBeNull();
  });

  it("does not walk a huge string", () => {
    const start = performance.now();
    expect(cleanLine("x ".repeat(5_000_000), 20)!.length).toBeLessThanOrEqual(20);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("keeps markup as plain text, to be shown as text and never as HTML", () => {
    expect(cleanLine("<script>alert(1)</script> <b>hi</b>", 100)).toBe("<script>alert(1)</script> <b>hi</b>");
  });
});

describe("an address from a stranger", () => {
  it("is an absolute http or https address", () => {
    expect(cleanUrl("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(cleanUrl("http://example.com")).toBe("http://example.com/");
  });

  it("is nothing else: not another scheme, not relative, not with a name and password, not with a control character, not too long", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,x", "file:///x", "ftp://example.com", "/relative", "example.com", "https://a@b.example/", "https://u:p@b.example/", "https://example.com/a‮b", `https://example.com/${"a".repeat(3000)}`, null, 5, {}]) {
      expect(cleanUrl(value), String(value)).toBeNull();
    }
  });
});

describe("the previews of a message", () => {
  const good = { url: "https://example.com/a", title: "A page", description: "About it", siteName: "Example" };

  it("keeps a good one as it is", () => {
    expect(parseEmbeds([good])).toEqual([good]);
  });

  it("is empty for anything that is not a list, and never throws", () => {
    for (const value of [null, undefined, "x", 5, {}, { 0: good }, true]) expect(parseEmbeds(value), String(value)).toEqual([]);
  });

  it("drops one with a bad address, or with nothing to show, and keeps the others", () => {
    const out = parseEmbeds([{ ...good, url: "javascript:alert(1)" }, { url: "https://example.com/b" }, { url: "https://example.com/c", title: "  " }, null, "x", good]);
    expect(out).toEqual([good]);
  });

  it("needs only a title or a description, and blanks the rest", () => {
    expect(parseEmbeds([{ url: "https://example.com/a", title: "T" }])).toEqual([{ url: "https://example.com/a", title: "T", description: null, siteName: null }]);
    expect(parseEmbeds([{ url: "https://example.com/a", description: "D" }])).toEqual([{ url: "https://example.com/a", title: null, description: "D", siteName: null }]);
  });

  it("cuts every field to its length, and drops any other field it was sent", () => {
    const [one] = parseEmbeds([{ url: "https://example.com/a", title: "t".repeat(1000), description: "d".repeat(1000), siteName: "s".repeat(1000), imageUrl: "https://evil.example/x.png", html: "<b>" }]);
    expect([...one.title!]).toHaveLength(EMBED_LIMITS.title);
    expect([...one.description!]).toHaveLength(EMBED_LIMITS.description);
    expect([...one.siteName!]).toHaveLength(EMBED_LIMITS.siteName);
    expect(Object.keys(one).sort()).toEqual(["description", "siteName", "title", "url"]);
  });

  it("shows no more than the limit, and the same page once", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...good, url: `https://example.com/${i}` }));
    expect(parseEmbeds(many)).toHaveLength(MAX_EMBEDS);
    expect(parseEmbeds([good, good, { ...good, title: "again" }])).toHaveLength(1);
  });

  it("can be compared", () => {
    expect(sameEmbeds([good], [{ ...good }])).toBe(true);
    expect(sameEmbeds([good], [{ ...good, title: "other" }])).toBe(false);
    expect(sameEmbeds([good], [])).toBe(false);
  });
});
