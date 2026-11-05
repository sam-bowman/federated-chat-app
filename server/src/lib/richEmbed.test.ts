import { describe, expect, it } from "vitest";
import {
  RICH_EMBED_LIMITS,
  cleanBlock,
  cleanColor,
  cleanRichEmbeds,
  embedsAsText,
  fallbackText,
  prepareRichEmbeds,
  richEmbedInputSchema,
  textLengthOf,
  type RichEmbed,
} from "./richEmbed.js";

const card = (over: Partial<RichEmbed> = {}): RichEmbed => ({ title: "Title", description: null, url: null, color: null, fields: [], footer: null, ...over });
const copy = { url: "https://chat.example/uploads/a.png", width: 640, height: 480 };

describe("cleanBlock", () => {
  it("keeps line breaks, collapses the rest of the whitespace, and drops blank runs and the ends", () => {
    expect(cleanBlock("  one \t two  \r\n\r\n\r\n\r\n three \n", 100)).toBe("one two\n\nthree");
    expect(cleanBlock("a\rb", 10)).toBe("a\nb");
  });

  it("removes control, format and separator characters (they can hide or reorder text)", () => {
    // (A line separator is whitespace, so it becomes the space between words, as in a line of text.)
    expect(cleanBlock("a\u0000b‮c​d e", 100)).toBe("abcd e");
  });

  it("is null when nothing is left, or when it is not text", () => {
    for (const v of ["", "   ", "\n\n", "​", 5, null, undefined, {}, []]) expect(cleanBlock(v, 10), String(v)).toBeNull();
  });

  it("is cut to the limit in characters (an emoji counts as one) and says so", () => {
    expect(cleanBlock("abcdefghij", 6)).toBe("abcde…");
    expect(cleanBlock("😀".repeat(10), 4)).toBe("😀😀😀…");
    expect(cleanBlock("abcdef", 6)).toBe("abcdef");
  });
});

describe("cleanColor", () => {
  it("takes #rrggbb in any case and stores it lower case, and nothing else", () => {
    expect(cleanColor("#AABBCC")).toBe("#aabbcc");
    for (const v of ["aabbcc", "#abc", "#aabbccdd", "#gggggg", "red", 5, null, "url(javascript:1)"]) expect(cleanColor(v), String(v)).toBeNull();
  });
});

describe("cleanRichEmbeds (what is stored, relayed and shown)", () => {
  it("keeps a good card as it is", () => {
    const good = card({
      description: "Line one\nLine two",
      url: "https://example.com/a",
      color: "#112233",
      fields: [{ name: "Year", value: "2021", inline: true }],
      footer: "via Requestrr",
      image: copy,
      thumbnail: copy,
    });
    expect(cleanRichEmbeds([good])).toEqual([good]);
  });

  it("is an empty list for anything that is not a list, and ignores entries that are not cards", () => {
    for (const v of [null, undefined, "x", 5, {}, { title: "t" }]) expect(cleanRichEmbeds(v), String(v)).toEqual([]);
    expect(cleanRichEmbeds([null, "x", 5, [], card()])).toEqual([card()]);
  });

  it("shows at most three cards", () => {
    expect(cleanRichEmbeds([1, 2, 3, 4, 5].map((n) => card({ title: `Card ${n}` })))).toHaveLength(3);
  });

  it("drops a card that shows nothing: no title, description or field, and no picture", () => {
    expect(cleanRichEmbeds([{ url: "https://example.com", color: "#112233", footer: "only a footer" }, { title: "  " }])).toEqual([]);
    expect(cleanRichEmbeds([{ image: copy }])).toEqual([{ title: null, description: null, url: null, color: null, fields: [], footer: null, image: copy }]);
  });

  it("cuts every text to its limit", () => {
    const [out] = cleanRichEmbeds([
      { title: "t".repeat(500), description: "d".repeat(5000), footer: "f".repeat(500), fields: [{ name: "n".repeat(500), value: "v".repeat(5000) }] },
    ]);
    expect([...out.title!]).toHaveLength(RICH_EMBED_LIMITS.title);
    expect([...out.description!]).toHaveLength(RICH_EMBED_LIMITS.description);
    expect([...out.footer!]).toHaveLength(RICH_EMBED_LIMITS.footer);
    expect([...out.fields[0].name]).toHaveLength(RICH_EMBED_LIMITS.fieldName);
    expect([...out.fields[0].value]).toHaveLength(RICH_EMBED_LIMITS.fieldValue);
  });

  it("keeps at most ten fields, each with a name and a value, and `inline` only when it is exactly true", () => {
    const fields = Array.from({ length: 14 }, (_, i) => ({ name: `Field ${i}`, value: "v", inline: i === 0 ? true : "yes" }));
    const [out] = cleanRichEmbeds([{ title: "t", fields: [...fields, { name: "", value: "no name" }, { name: "no value", value: " " }, "x", null] }]);
    expect(out.fields).toHaveLength(RICH_EMBED_LIMITS.fields);
    expect(out.fields[0].inline).toBe(true);
    expect(out.fields.slice(1).every((f) => f.inline === false)).toBe(true);
  });

  it("keeps an address only when it is a plain http(s) one with no name and password in it", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.com", "/relative", "https://user:pw@example.com", "not a url", `https://example.com/${"a".repeat(3000)}`, 5]) {
      expect(cleanRichEmbeds([{ title: "t", url: bad }])[0].url, String(bad)).toBeNull();
    }
    expect(cleanRichEmbeds([{ title: "t", url: "https://example.com/a?b=1" }])[0].url).toBe("https://example.com/a?b=1");
  });

  it("keeps a picture only as a copy: an address with a size inside the limits a copy is held to", () => {
    const bare = { title: "t", image: "https://example.com/a.png", thumbnail: { url: "https://example.com/a.png" } };
    const [out] = cleanRichEmbeds([bare]);
    expect(out.image).toBeUndefined();
    expect(out.thumbnail).toBeUndefined();
    expect(cleanRichEmbeds([{ title: "t", image: { ...copy, width: 99999 } }])[0].image).toBeUndefined();
    expect(cleanRichEmbeds([{ title: "t", image: { ...copy, url: "javascript:1" } }])[0].image).toBeUndefined();
  });

  it("holds all the text of a message's cards to its limit, by leaving out the cards that do not fit", () => {
    const big = (n: number) => ({ title: `Card ${n}`, description: "d".repeat(1500), fields: [{ name: "n", value: "v".repeat(300) }] });
    const out = cleanRichEmbeds([big(1), big(2), big(3)]);
    expect(out.length).toBeLessThan(3);
    expect(out.reduce((sum, c) => sum + textLengthOf(c), 0)).toBeLessThanOrEqual(RICH_EMBED_LIMITS.totalText);
    expect(out[0].title).toBe("Card 1");
  });

  it("is a function of its input alone: cleaning what it already cleaned changes nothing", () => {
    const once = cleanRichEmbeds([{ title: "  a\u0000b  ", description: "x\n\n\ny", url: "https://example.com", color: "#ABCDEF", fields: [{ name: "n", value: "v" }] }]);
    expect(cleanRichEmbeds(once)).toEqual(once);
  });
});

describe("prepareRichEmbeds (what a bot sends)", () => {
  const input = (over: Record<string, unknown> = {}) => richEmbedInputSchema.parse({ title: "Dune", description: "A 2021 film", ...over });

  it("cleans each card, leaves its pictures out until a copy exists, and sets aside the addresses to copy", () => {
    const result = prepareRichEmbeds([input({ image: "https://example.com/poster.png", thumbnail: "https://example.com/t.png", color: "#ABCDEF" })]);
    expect(result).toEqual({
      ok: true,
      embeds: [{ title: "Dune", description: "A 2021 film", url: null, color: "#abcdef", fields: [], footer: null }],
      sources: [{ image: "https://example.com/poster.png", thumbnail: "https://example.com/t.png" }],
    });
  });

  it("sets aside only addresses that are plain http(s) ones", () => {
    const result = prepareRichEmbeds([input({ image: "javascript:alert(1)", thumbnail: "https://u:p@example.com/t.png" })]);
    expect(result).toMatchObject({ ok: true, sources: [{ image: null, thumbnail: null }] });
  });

  it("refuses a card whose text is over a limit, instead of quietly cutting what its author wrote", () => {
    for (const over of [
      { title: "t".repeat(RICH_EMBED_LIMITS.title + 1) },
      { description: "d".repeat(RICH_EMBED_LIMITS.description + 1) },
      { footer: "f".repeat(RICH_EMBED_LIMITS.footer + 1) },
      { fields: [{ name: "n".repeat(RICH_EMBED_LIMITS.fieldName + 1), value: "v" }] },
      { fields: [{ name: "n", value: "v".repeat(RICH_EMBED_LIMITS.fieldValue + 1) }] },
    ]) {
      expect(prepareRichEmbeds([input(over)]), JSON.stringify(over).slice(0, 40)).toEqual({ ok: false, error: "invalid_embeds" });
    }
    expect(prepareRichEmbeds([input({ title: "t".repeat(RICH_EMBED_LIMITS.title) })]).ok).toBe(true);
  });

  it("counts characters, not UTF-16 units: a title of 150 emoji is within the limit", () => {
    expect(prepareRichEmbeds([input({ title: "😀".repeat(RICH_EMBED_LIMITS.title) })]).ok).toBe(true);
    expect(prepareRichEmbeds([input({ title: "😀".repeat(RICH_EMBED_LIMITS.title + 1) })]).ok).toBe(false);
  });

  it("refuses a card that shows nothing once cleaned, and a card that is only pictures", () => {
    expect(prepareRichEmbeds([input({ title: "​", description: undefined })])).toEqual({ ok: false, error: "invalid_embeds" });
    expect(prepareRichEmbeds([{ image: "https://example.com/a.png" }])).toEqual({ ok: false, error: "invalid_embeds" });
    expect(prepareRichEmbeds([{ color: "#112233", url: "https://example.com", footer: "only" }])).toEqual({ ok: false, error: "invalid_embeds" });
  });

  it("refuses cards whose words together are over the message's limit", () => {
    const heavy = () => input({ description: "d".repeat(1500), fields: [{ name: "n", value: "v".repeat(300) }] });
    expect(prepareRichEmbeds([heavy(), heavy()])).toMatchObject({ ok: true });
    expect(prepareRichEmbeds([heavy(), heavy(), heavy()])).toEqual({ ok: false, error: "embeds_too_large" });
  });

  it("is checked in the shape too: no more than ten fields or three cards, and unknown keys are dropped", () => {
    expect(richEmbedInputSchema.safeParse({ title: "t", fields: Array.from({ length: 11 }, () => ({ name: "n", value: "v" })) }).success).toBe(false);
    expect(richEmbedInputSchema.safeParse({ title: 5 }).success).toBe(false);
    expect(richEmbedInputSchema.parse({ title: "t", surprise: 1 })).toEqual({ title: "t" });
  });
});

describe("words for where cards cannot be seen", () => {
  it("makes the stand-in text from the first title, else the first line of a description, else a fixed word", () => {
    expect(fallbackText([card({ title: "Dune" }), card({ title: "Other" })])).toBe("Dune");
    expect(fallbackText([card({ title: null, description: "First line\nSecond line" })])).toBe("First line");
    expect(fallbackText([card({ title: null, description: null, fields: [{ name: "n", value: "v", inline: false }] })])).toBe("Embed");
    expect(fallbackText([])).toBe("Embed");
  });

  it("reads all the words on the cards, for a report", () => {
    const text = embedsAsText([card({ title: "Dune", description: "A film", fields: [{ name: "Year", value: "2021", inline: false }], footer: "via bot" }), card({ title: "Second" })]);
    expect(text).toBe("Dune\nA film\nYear: 2021\nvia bot\n\nSecond");
    expect(embedsAsText(null)).toBe("");
    expect(embedsAsText("nonsense")).toBe("");
  });
});
