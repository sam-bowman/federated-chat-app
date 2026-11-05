import { previewHref, previewPicture } from "./linkPreviews";

// A bot's cards (#132, phase 3a) as the client draws them. The server has cleaned every card (lib/richEmbed.ts there) and so has any server it
// came from, but a card is a stranger's text and this is the last line before it becomes something in the page, so each part is checked again
// here: only text is drawn (never HTML or markdown), the title's link and the pictures must be plain http(s) addresses with no credentials, and
// the colour must be exactly `#rrggbb` (it reaches CSS only as a custom property). Pictures are copies a server of the federation kept, and are
// drawn only while this device shows them (the same choice as the pictures on link previews).

const COLOUR = /^#[0-9a-fA-F]{6}$/;
const MAX_CARDS = 3;
const MAX_FIELDS = 10;

export interface Picture {
  src: string;
  width: number;
  height: number;
}

export interface Card {
  title: string | null;
  description: string | null;
  /** Where the title goes, if it is a plain http(s) address. */
  href: string | null;
  /** `#rrggbb`, or null. */
  colour: string | null;
  fields: { name: string; value: string; inline: boolean }[];
  footer: string | null;
  image: Picture | null;
  thumbnail: Picture | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * The cards of a message that can be drawn: at most three, each with something to show. `showPictures` is whether this device shows pictures
 * on previews; a card that was only a picture goes with it. Anything that is not a card is ignored, and nothing here throws.
 */
export function cardsOf(value: unknown, showPictures: boolean): Card[] {
  if (!Array.isArray(value)) return [];
  const out: Card[] = [];
  for (const item of value) {
    if (out.length >= MAX_CARDS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const fields: Card["fields"] = [];
    if (Array.isArray(record.fields)) {
      for (const f of record.fields) {
        if (fields.length >= MAX_FIELDS) break;
        if (!f || typeof f !== "object") continue;
        const field = f as Record<string, unknown>;
        const name = text(field.name);
        const val = text(field.value);
        if (name !== null && val !== null) fields.push({ name, value: val, inline: field.inline === true });
      }
    }
    const card: Card = {
      title: text(record.title),
      description: text(record.description),
      href: previewHref(record.url),
      colour: typeof record.color === "string" && COLOUR.test(record.color) ? record.color.toLowerCase() : null,
      fields,
      footer: text(record.footer),
      image: showPictures ? previewPicture(record.image) : null,
      thumbnail: showPictures ? previewPicture(record.thumbnail) : null,
    };
    if (card.title === null && card.description === null && card.fields.length === 0 && !card.image && !card.thumbnail) continue;
    out.push(card);
  }
  return out;
}

/** A few words standing for a message's cards where they cannot be drawn (a system notification): the first card's title, else the first line of its description. */
export function cardsSummary(value: unknown): string | null {
  for (const card of cardsOf(value, false)) {
    if (card.title) return card.title;
    if (card.description) return card.description.split("\n")[0].trim() || null;
  }
  return null;
}
