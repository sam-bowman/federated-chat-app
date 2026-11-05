import { z } from "zod";
import { cleanImage, cleanLine, cleanUrl, type EmbedImage } from "./linkPreview/embed.js";

// A bot's card (#132, phase 3a, docs/commands-design.md): a structured embed under a message, chosen by the bot and so richer than a link
// preview (lib/linkPreview/embed.ts, which is what this server read from a page and is a different column). Everything in one is a STRANGER'S
// text shown to other people, so it is never trusted as it comes: it is cut to fixed lengths, control and bidi characters are removed, and
// only plain http(s) addresses survive. This runs on what a bot sends (strictly: too long is a refusal the bot's author can see), on what is
// stored, and on what another server relays (leniently: cut, never an error), so all three agree.
// Kept free of config.ts imports so it can be unit-tested on its own.

export interface RichEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface RichEmbed {
  title: string | null;
  description: string | null;
  /** Makes the title a link. An absolute http(s) address with no credentials. */
  url: string | null;
  /** `#rrggbb`, the card's side stripe. */
  color: string | null;
  fields: RichEmbedField[];
  footer: string | null;
  /** Present only once this server (or the author's) kept a COPY of the picture: the bot's own address is never shown to readers. */
  image?: EmbedImage;
  thumbnail?: EmbedImage;
}

export const RICH_EMBED_LIMITS = {
  /** A message carries no more cards than this. */
  count: 3,
  title: 150,
  description: 1500,
  fields: 10,
  fieldName: 60,
  fieldValue: 300,
  footer: 100,
  /** Everything a message's cards say, added up (titles, descriptions, field names and values, footers). */
  totalText: 4000,
} as const;

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const COLOUR = /^#[0-9a-fA-F]{6}$/;

/** Text of at most `max` characters that may span lines: each line is cleaned like one line of text, blank runs are one blank line. Null if nothing is left. */
export function cleanBlock(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const lines: string[] = [];
  // Bounded first, so a huge string is not walked: a block this long is cut anyway.
  for (const raw of value.slice(0, max * 8).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/\s+/gu, " ").replace(UNSAFE, "").replace(/\s+/gu, " ").trim();
    if (line === "" && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;
  const characters = [...lines.join("\n")];
  return characters.length <= max ? characters.join("") : `${characters.slice(0, max - 1).join("").trimEnd()}…`;
}

/** `#rrggbb` in lower case, or null. */
export function cleanColor(value: unknown): string | null {
  return typeof value === "string" && COLOUR.test(value) ? value.toLowerCase() : null;
}

const length = (text: string | null) => (text === null ? 0 : [...text].length);

/** The characters of text a card says, for the limit on a message's cards added together. */
export function textLengthOf(embed: RichEmbed): number {
  return (
    length(embed.title) + length(embed.description) + length(embed.footer) + embed.fields.reduce((sum, f) => sum + length(f.name) + length(f.value), 0)
  );
}

function cleanFields(value: unknown): RichEmbedField[] {
  if (!Array.isArray(value)) return [];
  const out: RichEmbedField[] = [];
  for (const item of value) {
    if (out.length >= RICH_EMBED_LIMITS.fields) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = cleanLine(record.name, RICH_EMBED_LIMITS.fieldName);
    const text = cleanBlock(record.value, RICH_EMBED_LIMITS.fieldValue);
    if (name === null || text === null) continue;
    out.push({ name, value: text, inline: record.inline === true });
  }
  return out;
}

/** One card as it is allowed to be, or null if nothing shows (no title, description, field or picture). */
function cleanOne(record: Record<string, unknown>, withPictures: boolean): RichEmbed | null {
  const embed: RichEmbed = {
    title: cleanLine(record.title, RICH_EMBED_LIMITS.title),
    description: cleanBlock(record.description, RICH_EMBED_LIMITS.description),
    url: cleanUrl(record.url),
    color: cleanColor(record.color),
    fields: cleanFields(record.fields),
    footer: cleanLine(record.footer, RICH_EMBED_LIMITS.footer),
  };
  if (withPictures) {
    const image = cleanImage(record.image);
    const thumbnail = cleanImage(record.thumbnail);
    if (image) embed.image = image;
    if (thumbnail) embed.thumbnail = thumbnail;
  }
  // A link with nothing to say is no card, and a stripe alone is not one either.
  if (embed.title === null && embed.description === null && embed.fields.length === 0 && !embed.image && !embed.thumbnail) return null;
  return embed;
}

/**
 * Whatever was stored, or another server relayed, as the cards it is allowed to be: an array of no more than RICH_EMBED_LIMITS.count
 * objects, each cleaned and cut, pictures kept only as copies (an address with a size), the message's total text held to its limit by
 * dropping the cards that do not fit. Never throws.
 */
export function cleanRichEmbeds(value: unknown): RichEmbed[] {
  if (!Array.isArray(value)) return [];
  const out: RichEmbed[] = [];
  let total = 0;
  for (const item of value) {
    if (out.length >= RICH_EMBED_LIMITS.count) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const embed = cleanOne(item as Record<string, unknown>, true);
    if (!embed) continue;
    total += textLengthOf(embed);
    if (total > RICH_EMBED_LIMITS.totalText) break;
    out.push(embed);
  }
  return out;
}

// --- What a bot sends -------------------------------------------------------------------------------------------------------------------

/**
 * The shape a bot sends. Strict on lengths so its author is told (a 400), and it names pictures only by address (`image`, `thumbnail`): the
 * server fetches and keeps its own copy, and shows that. Unknown keys are dropped.
 */
export const richEmbedInputSchema = z.object({
  title: z.string().max(RICH_EMBED_LIMITS.title * 4).optional(),
  description: z.string().max(RICH_EMBED_LIMITS.description * 4).optional(),
  url: z.string().max(2048).optional(),
  color: z.string().max(7).optional(),
  fields: z
    .array(
      z.object({
        name: z.string().max(RICH_EMBED_LIMITS.fieldName * 4),
        value: z.string().max(RICH_EMBED_LIMITS.fieldValue * 4),
        inline: z.boolean().optional(),
      })
    )
    .max(RICH_EMBED_LIMITS.fields)
    .optional(),
  footer: z.string().max(RICH_EMBED_LIMITS.footer * 4).optional(),
  image: z.string().max(2048).optional(),
  thumbnail: z.string().max(2048).optional(),
});

export type RichEmbedInput = z.infer<typeof richEmbedInputSchema>;

/** The addresses a bot named for a card's pictures, to be fetched and copied; null where it named none (or not a plain http(s) address). */
export interface PictureSources {
  image: string | null;
  thumbnail: string | null;
}

export type PreparedRichEmbeds =
  | { ok: true; embeds: RichEmbed[]; sources: PictureSources[] }
  | { ok: false; error: "invalid_embeds" | "embeds_too_large" };

const tooLong = (text: string | undefined, max: number) => text !== undefined && [...text].length > max;

/**
 * What a bot sent, ready to store: each card cleaned (and without pictures yet), the addresses of the pictures it named set aside to be
 * copied. Refuses a card that is over a length (rather than quietly cutting what its author wrote), one that shows nothing once cleaned, and
 * cards whose text together is over the message's limit.
 */
export function prepareRichEmbeds(input: RichEmbedInput[]): PreparedRichEmbeds {
  const embeds: RichEmbed[] = [];
  const sources: PictureSources[] = [];
  let total = 0;
  for (const raw of input) {
    if (
      tooLong(raw.title, RICH_EMBED_LIMITS.title) ||
      tooLong(raw.description, RICH_EMBED_LIMITS.description) ||
      tooLong(raw.footer, RICH_EMBED_LIMITS.footer) ||
      (raw.fields ?? []).some((f) => tooLong(f.name, RICH_EMBED_LIMITS.fieldName) || tooLong(f.value, RICH_EMBED_LIMITS.fieldValue))
    ) {
      return { ok: false, error: "invalid_embeds" };
    }
    // Pictures are not words: a card needs a title, a description or a field, and the pictures decorate it (a card that is only a picture
    // would be nothing at all to a server that cannot show it, and until its copy arrives).
    const card = cleanOne(raw as Record<string, unknown>, false);
    if (!card) return { ok: false, error: "invalid_embeds" };
    total += textLengthOf(card);
    if (total > RICH_EMBED_LIMITS.totalText) return { ok: false, error: "embeds_too_large" };
    embeds.push(card);
    sources.push({ image: cleanUrl(raw.image), thumbnail: cleanUrl(raw.thumbnail) });
  }
  return { ok: true, embeds, sources };
}

// --- Words ------------------------------------------------------------------------------------------------------------------------------

/**
 * The plain text that stands for cards where a reader cannot see them: what a message with no text of its own carries to a server that
 * predates cards (which requires some text and shows only that). Deterministic, so a server that does know cards can tell it from words a
 * bot wrote and drop it (a card is not shown twice): the first card's title, else the first line of its description, else a fixed word.
 */
export function fallbackText(embeds: RichEmbed[]): string {
  for (const embed of embeds) {
    if (embed.title) return embed.title;
    if (embed.description) return cleanLine(embed.description.split("\n")[0], RICH_EMBED_LIMITS.title) ?? "Embed";
  }
  return "Embed";
}

/** All the words on the cards, for a report that must say what was reported. Cut by the caller. */
export function embedsAsText(raw: unknown): string {
  return cleanRichEmbeds(raw)
    .map((e) => [e.title, e.description, ...e.fields.map((f) => `${f.name}: ${f.value}`), e.footer].filter((x): x is string => !!x).join("\n"))
    .join("\n\n");
}
