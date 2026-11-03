import { describe, expect, it } from "vitest";
import { decodeEntities, hostLabel, readPageImageAddress, readPageMeta } from "./pageMeta.js";

const page = (head: string) => `<!doctype html><html><head>${head}</head><body><h1>x</h1></body></html>`;

describe("what a page says about itself", () => {
  it("is its Open Graph title, description and site name", () => {
    const meta = readPageMeta(
      page(`<title>Plain title</title><meta property="og:title" content="OG title"><meta property="og:description" content="OG description"><meta property="og:site_name" content="Example Site">`),
      "https://www.example.com/a"
    );
    expect(meta).toEqual({ title: "OG title", description: "OG description", siteName: "Example Site" });
  });

  it("falls back: Twitter's, then the page's own title and description, and the site's address for its name", () => {
    expect(readPageMeta(page(`<meta name="twitter:title" content="Tw"><meta name="twitter:description" content="TwD">`), "https://www.example.com/a")).toEqual({ title: "Tw", description: "TwD", siteName: "example.com" });
    expect(readPageMeta(page(`<title>Just a title</title><meta name="description" content="Meta description">`), "https://example.org/")).toEqual({ title: "Just a title", description: "Meta description", siteName: "example.org" });
  });

  it("reads tags written in other ways: single quotes, no quotes, any case, any order", () => {
    const meta = readPageMeta(page(`<META CONTENT='Single' PROPERTY=og:title><meta content=Bare name=description>`), "https://example.com/");
    expect(meta.title).toBe("Single");
    expect(meta.description).toBe("Bare");
  });

  it("turns entities back into characters, in titles and descriptions", () => {
    const meta = readPageMeta(page(`<title>Tom &amp; Jerry&#39;s &#x2014; &quot;ok&quot;</title>`), "https://example.com/");
    expect(meta.title).toBe(`Tom & Jerry's — "ok"`);
  });

  it("has nothing for a page with nothing to say, and still names the site", () => {
    expect(readPageMeta("<html><body>hello</body></html>", "https://example.com/x")).toEqual({ title: null, description: null, siteName: "example.com" });
  });

  it("does not read the body: a title in it is not the page's", () => {
    const html = page("") + `<meta property="og:title" content="in the body">`;
    expect(readPageMeta(html, "https://example.com/").title).toBeNull();
  });

  it("keeps markup in what it reads as plain text, and cuts long text", () => {
    const meta = readPageMeta(page(`<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;"><meta property="og:description" content="${"d".repeat(2000)}">`), "https://example.com/");
    expect(meta.title).toBe("<img src=x onerror=alert(1)>");
    expect([...meta.description!].length).toBe(300);
  });

  it("reads a <title> as plain text too: what looks like a tag in it is just characters", () => {
    expect(readPageMeta(page(`<title>a <b>bold</b> &lt;script&gt; move</title>`), "https://example.com/").title).toBe("a <b>bold</b> <script> move");
  });

  it("cannot be made slow by a hostile page", () => {
    const hostile = [
      "<meta ".repeat(100000),
      `<meta content="${"a".repeat(1_000_000)}`,
      "<title>" + "<".repeat(1_000_000),
      "<head>" + '<meta property="og:title" content="x">'.repeat(100000),
      `<title ${"a=".repeat(200000)}`,
    ];
    for (const html of hostile) {
      const start = performance.now();
      readPageMeta(html, "https://example.com/");
      expect(performance.now() - start, html.slice(0, 30)).toBeLessThan(1000);
    }
  });
});

describe("entities", () => {
  it("decodes the common named ones and numbers, and leaves what it does not know", () => {
    expect(decodeEntities("&amp; &lt; &gt; &quot; &apos; &nbsp; &#65; &#x41; &unknown; &#0; &#xD800; &#99999999;")).toBe(`& < > " '   A A &unknown; &#0; &#xD800; &#99999999;`);
  });
});

describe("the host to show", () => {
  it("is the address's host without www., or nothing for something that is not an address", () => {
    expect(hostLabel("https://www.Example.com/x")).toBe("example.com");
    expect(hostLabel("not a url")).toBeNull();
  });
});

describe("the address of the page's picture (#244)", () => {
  const at = "https://www.example.com/blog/post";

  it("is the Open Graph one, then Twitter's", () => {
    expect(readPageImageAddress(page(`<meta property="og:image" content="https://cdn.example.com/a.png">`), at)).toBe("https://cdn.example.com/a.png");
    expect(readPageImageAddress(page(`<meta name="twitter:image" content="https://cdn.example.com/t.png">`), at)).toBe("https://cdn.example.com/t.png");
    expect(
      readPageImageAddress(page(`<meta name="twitter:image" content="https://cdn.example.com/t.png"><meta property="og:image" content="https://cdn.example.com/og.png">`), at)
    ).toBe("https://cdn.example.com/og.png");
    expect(
      readPageImageAddress(page(`<meta property="og:image" content="http://cdn.example.com/plain.png"><meta property="og:image:secure_url" content="https://cdn.example.com/secure.png">`), at)
    ).toBe("https://cdn.example.com/secure.png");
  });

  it("is made absolute against the page it came from", () => {
    expect(readPageImageAddress(page(`<meta property="og:image" content="/img/a.png">`), at)).toBe("https://www.example.com/img/a.png");
    expect(readPageImageAddress(page(`<meta property="og:image" content="a.png">`), at)).toBe("https://www.example.com/blog/a.png");
    expect(readPageImageAddress(page(`<meta property="og:image" content="//cdn.example.com/a.png">`), at)).toBe("https://cdn.example.com/a.png");
  });

  it("is null when there is none, or it is not a plain http(s) address", () => {
    expect(readPageImageAddress(page(`<title>x</title>`), at)).toBeNull();
    for (const content of ["javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd", "https://u:p@cdn.example.com/a.png", "", "   ", "http://", `https://cdn.example.com/${"a".repeat(3000)}`]) {
      expect(readPageImageAddress(page(`<meta property="og:image" content="${content}">`), at), content.slice(0, 30)).toBeNull();
    }
  });

  it("never lets a control or bidi character through: resolving the address writes it out as %-escapes", () => {
    expect(readPageImageAddress(page(`<meta property="og:image" content="https://cdn.example.com/a‮.png">`), at)).toBe("https://cdn.example.com/a%E2%80%AE.png");
  });

  it("passes over a bad candidate to a good one", () => {
    expect(readPageImageAddress(page(`<meta property="og:image" content="javascript:alert(1)"><meta name="twitter:image" content="https://cdn.example.com/t.png">`), at)).toBe("https://cdn.example.com/t.png");
  });

  it("cannot be made slow by a hostile page", () => {
    const started = Date.now();
    readPageImageAddress(page("<meta ".repeat(100000)), at);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
