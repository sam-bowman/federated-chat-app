import type { Community } from "../api";
import { contrastRatio } from "./contrast";

// What the tile (a community's icon on the rail) shows when it has no picture: 1 to 3 letters on a colour.
// The server validates the same things (server/src/lib/communityIcon.ts); this is for the form and for
// choosing what to draw.

export const ICON_TEXT_MAX_CHARACTERS = 3;

const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** The characters of a text as a person counts them: an emoji with a skin tone or a flag is one. */
export function characters(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(text)].map((part) => part.segment);
}

/** The letters a tile shows by default: the first two characters of the name, in capitals. */
export function defaultIconText(name: string): string {
  return characters(name.trim()).slice(0, 2).join("").toUpperCase();
}

/**
 * What a person typed into the letters box, as the value to save: trimmed, or null if it is not a
 * valid tile text (empty, more than three characters, or containing control characters).
 */
export function normaliseIconText(input: string): string | null {
  const text = input.trim();
  if (text === "" || UNSAFE_TEXT.test(text)) return null;
  return characters(text).length <= ICON_TEXT_MAX_CHARACTERS ? text : null;
}

const LIGHT_TEXT = "#ffffff";
// Pure black, not a near-black: with white and black the best of the two is at least 4.58:1 on ANY colour, so AA
// for normal text always holds; a softer dark text falls short (4.28:1) on some mid-tones.
const DARK_TEXT = "#000000";

/** White or black, whichever reads better on `background` (a #rrggbb colour). */
export function readableTextColour(background: string): string {
  return contrastRatio(LIGHT_TEXT, background) >= contrastRatio(DARK_TEXT, background) ? LIGHT_TEXT : DARK_TEXT;
}

export interface CommunityTile {
  /** The letters to draw (unused when there is a picture). */
  label: string;
  /** The chosen background and the text colour that reads on it, or null to use the default look. */
  colours: { background: string; text: string } | null;
  /** Three characters are drawn smaller so they fit. */
  small: boolean;
}

/** What to draw for a community's tile when it has no picture. */
export function communityTile(community: Pick<Community, "name" | "iconText" | "iconColor">): CommunityTile {
  const label = community.iconText?.trim() || defaultIconText(community.name);
  return {
    label,
    colours: community.iconColor
      ? { background: community.iconColor, text: readableTextColour(community.iconColor) }
      : null,
    small: characters(label).length >= 3,
  };
}
