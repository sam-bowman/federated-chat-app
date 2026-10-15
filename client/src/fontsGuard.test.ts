import { describe, expect, it } from "vitest";
import html from "../index.html?raw";
import licences from "../public/THIRD-PARTY-FONTS.txt?raw";
import fontsCss from "./fonts.css?raw";
import indexCss from "./index.css?raw";
import { FONT_CHOICES, fontStack } from "./lib/appearance";

// Fonts are self-hosted on purpose: a font CDN is a request that tells a third party who is using which server, and it
// would not work on an air-gapped deployment or in the desktop app. Nothing may load a font from another host.

const sources = import.meta.glob("./**/*.{ts,tsx,css}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const THIRD_PARTY = /fonts\.googleapis|fonts\.gstatic|use\.typekit|use\.fontawesome|cdnjs|jsdelivr|unpkg|bunny\.net/i;

describe("fonts are self-hosted", () => {
  it("loads every bundled font from its @fontsource package, as a woff2 file, with no address in it", () => {
    const urls = [...fontsCss.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1].replace(/^["']|["']$/g, ""));

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, url).toMatch(/^@fontsource\/[a-z-]+\/files\/[a-z-]+-latin-(400|700)-normal\.woff2$/);
      expect(url).not.toMatch(/^(https?:)?\/\//);
    }
  });

  it("has no web address anywhere in the font or style sheets, nor an @import of one", () => {
    for (const [name, css] of [["fonts.css", fontsCss], ["index.css", indexCss]] as const) {
      expect(css, name).not.toMatch(/https?:\/\//);
      expect(css, name).not.toMatch(/@import\s+url\(/);
    }
  });

  it("does not link a font stylesheet or preload a font from another host in index.html", () => {
    expect(html).not.toMatch(THIRD_PARTY);
    expect(html).not.toMatch(/<link[^>]+href="https?:\/\//i);
  });

  it("names no font CDN in any source file", () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.endsWith("fontsGuard.test.ts"))
      .filter(([, text]) => THIRD_PARTY.test(text))
      .map(([file]) => file);

    expect(offenders).toEqual([]);
  });
});

describe("every bundled font the settings offer is really bundled", () => {
  const bundled = FONT_CHOICES.filter((font) => font !== "default" && font !== "mono-system" && font !== "custom");
  const families = (css: string) => [...css.matchAll(/font-family:\s*"([^"]+)"/g)].map((m) => m[1]);

  it("has @font-face rules for the regular and the bold weight of each", () => {
    for (const font of bundled) {
      const family = /^"([^"]+)"/.exec(fontStack({ font, customFont: "" }) ?? "")![1];
      const faces = fontsCss.split("@font-face").slice(1).filter((face) => face.includes(`font-family: "${family}"`));
      expect(faces.map((f) => /font-weight:\s*(\d+)/.exec(f)![1]).sort(), family).toEqual(["400", "700"]);
    }
  });

  it("declares no family the settings do not offer", () => {
    const offered = bundled.map((font) => /^"([^"]+)"/.exec(fontStack({ font, customFont: "" }) ?? "")![1]);

    expect([...new Set(families(fontsCss))].sort()).toEqual([...offered].sort());
  });

  // The OFL asks that its notice goes with every copy of the fonts; the file is in public/, so it is served with the app.
  it("ships the licence and copyright notice of every bundled font", () => {
    for (const pkg of ["jetbrains-mono", "ibm-plex-mono", "fira-code"]) expect(licences, pkg).toContain(`@fontsource/${pkg}`);
    expect(licences.match(/SIL OPEN FONT LICENSE Version 1\.1/gi)?.length).toBe(bundled.length);
    expect(licences).toMatch(/Copyright 2020 The JetBrains Mono Project Authors/);
    expect(licences).toMatch(/Copyright 2017 IBM Corp/);
    expect(licences).toMatch(/Copyright 2014-2020 The Fira Code Project Authors/);
  });

  it("shows the text while a font loads, rather than hiding it", () => {
    const faces = fontsCss.split("@font-face").slice(1);
    for (const face of faces) expect(face).toContain("font-display: swap");
  });
});

describe("the stylesheet reads the font from the settings", () => {
  const css = indexCss.replaceAll("\r\n", "\n");

  it("sets the whole UI's font from --ui-font, falling back to the usual stack", () => {
    expect(css).toMatch(/font-family:\s*var\(--ui-font, "Segoe UI", system-ui, -apple-system, sans-serif\)/);
  });

  it("sets the font of messages and of the box you type them in from --message-font, inheriting when there is none", () => {
    const start = css.indexOf(".message-body,\n.composer input {");
    expect(start).not.toBe(-1);
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule).toContain("font-family: var(--message-font, inherit)");
    expect(rule).toContain("font-variant-ligatures: var(--message-ligatures, inherit)");
  });

  it("sets ligatures for the whole UI from --font-ligatures", () => {
    expect(css).toContain("font-variant-ligatures: var(--font-ligatures, normal)");
  });
});
