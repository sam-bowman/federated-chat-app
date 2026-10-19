import { describe, expect, it } from "vitest";
import { splitLinks, type MessagePart } from "./linkify";

const links = (text: string) => splitLinks(text).filter((p): p is Extract<MessagePart, { kind: "link" }> => p.kind === "link");
const only = (text: string) => links(text).map((l) => l.text);
const ch = (code: number) => String.fromCodePoint(code);

describe("splitLinks: what becomes a link", () => {
  it("finds an http or https address, and one with a port, path, query and fragment", () => {
    expect(only("see https://example.com/a/b?c=d&e=f#g and http://example.org:8080/x")).toEqual([
      "https://example.com/a/b?c=d&e=f#g",
      "http://example.org:8080/x",
    ]);
  });

  it("takes a www. address as https, showing what was typed", () => {
    expect(links("go to www.example.com/page now")).toEqual([{ kind: "link", text: "www.example.com/page", href: "https://www.example.com/page" }]);
  });

  it("is case-insensitive about the scheme", () => {
    expect(only("HTTPS://EXAMPLE.COM/Path")).toEqual(["HTTPS://EXAMPLE.COM/Path"]);
    expect(links("HTTPS://EXAMPLE.COM/Path")[0].href).toBe("https://example.com/Path");
  });

  it("accepts localhost and an address in brackets, which have no dot", () => {
    expect(only("http://localhost:3000/x and http://[::1]:4000/")).toEqual(["http://localhost:3000/x", "http://[::1]:4000/"]);
  });

  it("goes exactly where the text says, in the browser's normal form", () => {
    expect(links("https://Example.COM")[0].href).toBe("https://example.com/");
    expect(links("https://example.com/a b")[0].href).toBe("https://example.com/a");
  });

  it("joins back into the original message, text and links in order", () => {
    const message = "a https://x.example/1, then (www.y.example/2) and https://z.example/3.";
    expect(splitLinks(message).map((p) => p.text).join("")).toBe(message);
  });
});

describe("splitLinks: the edges of an address", () => {
  it("leaves sentence punctuation outside the link", () => {
    expect(only("Look: https://example.com/page.")).toEqual(["https://example.com/page"]);
    expect(only("https://example.com/a, https://example.com/b; https://example.com/c!? \"https://example.com/d\"")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/d",
    ]);
    expect(only("really? https://example.com/q?x=1?")).toEqual(["https://example.com/q?x=1"]);
  });

  it("works inside brackets, and keeps a bracket that belongs to the address", () => {
    expect(only("(see https://example.com/page)")).toEqual(["https://example.com/page"]);
    expect(only("[https://example.com/page]")).toEqual(["https://example.com/page"]);
    expect(only("https://en.example.org/wiki/Thing_(disambiguation)")).toEqual(["https://en.example.org/wiki/Thing_(disambiguation)"]);
    expect(only("(https://en.example.org/wiki/Thing_(disambiguation))")).toEqual(["https://en.example.org/wiki/Thing_(disambiguation)"]);
  });

  it("stops at an angle bracket and at whitespace of any kind", () => {
    expect(only("<https://example.com/a>")).toEqual(["https://example.com/a"]);
    expect(only("https://example.com/a\nhttps://example.com/b\thttps://example.com/c")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  it("finds several, side by side with text and emoticon-like words", () => {
    expect(only("https://a.example :party: https://b.example")).toEqual(["https://a.example", "https://b.example"]);
  });

  it("keeps something shaped like an emoticon trigger inside an address", () => {
    const parts = splitLinks("see https://example.com/a:b:c ok");
    expect(parts.filter((p) => p.kind === "link").map((p) => p.text)).toEqual(["https://example.com/a:b:c"]);
  });
});

describe("splitLinks: what is left alone", () => {
  it("is not fooled by times, versions, e-mail addresses or ordinary words", () => {
    for (const text of ["at 10:30 sharp", "version 1.2.3", "mail me: a@example.com", "www", "www.", "http", "https://", "see example.com", "foo.www.example.com"]) {
      expect(only(text), text).toEqual([]);
    }
  });

  it("does not take the tail of a longer word or path for the start of an address", () => {
    expect(only("awww.example.com")).toEqual([]);
    expect(only("path/www.example.com")).toEqual([]);
    expect(only("xhttps://example.com")).toEqual([]);
    // An e-mail address is not the start of a web address, even when its domain begins www.
    expect(only("write to name@www.example.com please")).toEqual([]);
    expect(only("name@https://example.com")).toEqual([]);
  });

  it("never makes a link of any other scheme, however it is written", () => {
    const hostile = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "ftp://example.com/x",
      "mailto:a@example.com",
      "tel:+1555",
      "//example.com/x",
      "hxxps://example.com",
      "https:example.com",
      "http:/example.com",
    ];
    for (const text of hostile) expect(links(`${text} and (${text})`), text).toEqual([]);
  });

  // An address after another scheme's name is still only the address: the link shows the https address and goes there, and
  // the other scheme is left as plain text.
  it("links only the http(s) part of text that has another scheme in front", () => {
    for (const text of ["see javascript:https://example.com", "blob:https://example.com/uuid", "data:https://example.com"]) {
      const found = links(text);
      expect(found, text).toHaveLength(1);
      expect(found[0].text.startsWith("https://")).toBe(true);
      expect(found[0].href).toMatch(/^https:\/\/example\.com\//);
    }
    expect(links("www.example.com@javascript:alert(1)").every((l) => l.href.startsWith("https://"))).toBe(true);
  });

  it("refuses an address with a name and password in it, which reads as one site and goes to another", () => {
    expect(links("https://paypal.com@evil.example/login")).toEqual([]);
    expect(links("https://user:secret@example.com/")).toEqual([]);
    expect(links("www.good.example@evil.example")).toEqual([]);
  });

  it("refuses a bare word, and a host that begins or ends with a dot", () => {
    expect(links("https://intranet")).toEqual([]);
    expect(links("https://.example.com")).toEqual([]);
    expect(links("https://example.com./x").length).toBe(0);
  });

  it("will not let a bidirectional override, a zero-width character or a control character into a link", () => {
    for (const code of [0x202e, 0x202d, 0x2066, 0x200b, 0x200e, 0xfeff, 0x00ad, 0x2028, 0x0007]) {
      const text = `https://example.com/a${ch(code)}b`;
      expect(only(text), `U+${code.toString(16)}`).toEqual(["https://example.com/a"]);
    }
  });
});

describe("splitLinks: hostile and large input", () => {
  it("copes with a very long address and a very long run of look-alikes quickly", () => {
    const long = `https://example.com/${"a".repeat(100_000)}`;
    const started = Date.now();
    expect(only(long)).toEqual([long]);
    splitLinks("www.".repeat(50_000));
    splitLinks("https://".repeat(20_000));
    splitLinks(`${"(".repeat(30_000)}https://example.com/${")".repeat(30_000)}`);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("handles many links", () => {
    const text = Array.from({ length: 500 }, (_, i) => `https://example.com/${i}`).join(" ");
    expect(links(text)).toHaveLength(500);
  });

  it("returns an empty message as no parts, and plain text as one", () => {
    expect(splitLinks("")).toEqual([]);
    expect(splitLinks("just words")).toEqual([{ kind: "text", text: "just words" }]);
  });
});
