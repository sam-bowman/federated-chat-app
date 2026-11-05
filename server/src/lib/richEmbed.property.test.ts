import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RICH_EMBED_LIMITS, cleanRichEmbeds, prepareRichEmbeds, richEmbedInputSchema, textLengthOf, type RichEmbed } from "./richEmbed.js";

// What must hold for ANY input to the cards a bot sends and another server relays: a stranger's text. The generators build the awkward cases on
// purpose (bidi overrides, controls, line separators, very long runs, more fields than allowed, addresses with a password in them), because a
// property over only friendly strings proves nothing about the ones that matter.

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const unsafe = fc.constantFrom("‮", "\u0000", "​", " ", "\r", "\u0007");
const text = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.string({ unit: "binary", maxLength: 100 }),
  fc.array(fc.oneof(fc.string({ maxLength: 20 }), unsafe), { maxLength: 20 }).map((parts) => parts.join("")),
  fc.string({ size: "max", maxLength: 7000 }),
  fc.constantFrom("😀".repeat(300), "x".repeat(10_000), "line\n\n\n\n\nbreaks\n")
);
const anything = fc.oneof(text, fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.string({ maxLength: 5 }), { maxLength: 3 }), fc.dictionary(fc.string({ maxLength: 5 }), fc.string({ maxLength: 5 }), { maxKeys: 3 }));
const address = fc.oneof(
  fc.webUrl(),
  fc.constantFrom("javascript:alert(1)", "https://user:pw@example.com/", "ftp://example.com", "data:text/html,x", "//example.com", `https://example.com/${"a".repeat(3000)}`),
  anything
);
const copy = fc.record({ url: address, width: fc.oneof(fc.integer({ min: 0, max: 8000 }), anything), height: fc.oneof(fc.integer({ min: 0, max: 8000 }), anything) });
const field = fc.oneof(fc.record({ name: anything, value: anything, inline: anything }, { requiredKeys: [] }), anything);
const card = fc.oneof(
  fc.record(
    {
      title: anything,
      description: anything,
      url: address,
      color: fc.oneof(fc.constantFrom("#AABBCC", "#aabbcc", "#abc", "red", "#gggggg"), anything),
      footer: anything,
      fields: fc.oneof(fc.array(field, { maxLength: 30, size: "max" }), anything),
      image: fc.oneof(copy, address),
      thumbnail: fc.oneof(copy, address),
    },
    { requiredKeys: [] }
  ),
  anything
);
const cards = fc.oneof(fc.array(card, { maxLength: 8, size: "max" }), anything);

function invariantsHold(embeds: RichEmbed[]): void {
  expect(embeds.length).toBeLessThanOrEqual(RICH_EMBED_LIMITS.count);
  let total = 0;
  for (const embed of embeds) {
    const texts = [embed.title, embed.description, embed.footer, ...embed.fields.flatMap((f) => [f.name, f.value])].filter((t): t is string => t !== null);
    for (const t of texts) {
      // Line breaks are the one control character a description or a value may keep.
      expect(UNSAFE.test(t.replace(/\n/g, ""))).toBe(false);
      expect(t.trim()).toBe(t);
      expect(t).not.toBe("");
    }
    expect([...(embed.title ?? "")].length).toBeLessThanOrEqual(RICH_EMBED_LIMITS.title);
    expect([...(embed.description ?? "")].length).toBeLessThanOrEqual(RICH_EMBED_LIMITS.description);
    expect([...(embed.footer ?? "")].length).toBeLessThanOrEqual(RICH_EMBED_LIMITS.footer);
    expect(embed.fields.length).toBeLessThanOrEqual(RICH_EMBED_LIMITS.fields);
    for (const f of embed.fields) {
      expect([...f.name].length).toBeLessThanOrEqual(RICH_EMBED_LIMITS.fieldName);
      expect([...f.value].length).toBeLessThanOrEqual(RICH_EMBED_LIMITS.fieldValue);
    }
    if (embed.url !== null) {
      const url = new URL(embed.url);
      expect(["http:", "https:"]).toContain(url.protocol);
      expect(url.username + url.password).toBe("");
    }
    if (embed.color !== null) expect(embed.color).toMatch(/^#[0-9a-f]{6}$/);
    for (const picture of [embed.image, embed.thumbnail]) {
      if (!picture) continue;
      expect(["http:", "https:"]).toContain(new URL(picture.url).protocol);
      expect(Number.isInteger(picture.width) && Number.isInteger(picture.height) && picture.width > 0 && picture.height > 0).toBe(true);
    }
    // Something shows.
    expect(embed.title !== null || embed.description !== null || embed.fields.length > 0 || !!embed.image || !!embed.thumbnail).toBe(true);
    total += textLengthOf(embed);
  }
  expect(total).toBeLessThanOrEqual(RICH_EMBED_LIMITS.totalText);
}

describe("cleanRichEmbeds, for any value", () => {
  it("never throws, and what it returns obeys every limit", () => {
    fc.assert(
      fc.property(cards, (value) => {
        invariantsHold(cleanRichEmbeds(value));
      }),
      { numRuns: 400 }
    );
  });

  it("is idempotent: cleaning what it already cleaned changes nothing", () => {
    fc.assert(
      fc.property(cards, (value) => {
        const once = cleanRichEmbeds(value);
        expect(cleanRichEmbeds(once)).toEqual(once);
      }),
      { numRuns: 400 }
    );
  });

  it("survives a JSON round trip (it is stored as JSON and relayed as JSON)", () => {
    fc.assert(
      fc.property(cards, (value) => {
        const once = cleanRichEmbeds(value);
        expect(cleanRichEmbeds(JSON.parse(JSON.stringify(once)))).toEqual(once);
      }),
      { numRuns: 200 }
    );
  });
});

describe("prepareRichEmbeds, for anything the request schema lets through", () => {
  it("never throws, and what it accepts is already clean and shows something", () => {
    fc.assert(
      fc.property(fc.array(card, { maxLength: 3, size: "max" }), (value) => {
        const parsed = richEmbedInputSchema.array().max(RICH_EMBED_LIMITS.count).safeParse(value);
        if (!parsed.success) return;
        const result = prepareRichEmbeds(parsed.data);
        if (!result.ok) return;
        expect(result.embeds.length).toBe(parsed.data.length);
        expect(result.sources.length).toBe(parsed.data.length);
        invariantsHold(result.embeds);
        // Cleaning what was accepted changes nothing, so what is stored is what the bot's author was told was accepted.
        expect(cleanRichEmbeds(result.embeds)).toEqual(result.embeds);
        for (const s of result.sources) for (const a of [s.image, s.thumbnail]) if (a !== null) expect(["http:", "https:"]).toContain(new URL(a).protocol);
      }),
      { numRuns: 400 }
    );
  });
});
