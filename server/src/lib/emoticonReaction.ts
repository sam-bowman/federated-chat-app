import { z } from "zod";

// A reaction with a custom emoticon (#110). A custom emoticon's `:trigger:` is per person - `:party:` means one thing
// to you and may be nothing to me - and a reaction is shown to everyone, so it carries a REFERENCE: the emoticon's
// own id and the name and picture to show it from, on whichever server it lives. The receiving server shows it
// from that picture without storing the emoticon.
//
// Nothing here reads the config or the database, so it can be unit tested on its own.

export interface EmoticonRef {
  /** The emoticon's protocolId on the server that owns it. */
  id: string;
  name: string;
  /** An absolute http(s) URL: a peer cannot resolve a path on OUR server. */
  imageUrl: string;
}

export type ReactionKind = { emoji: string } | { emoticon: EmoticonRef };

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * What another server may tell us about an emoticon. It is a stranger's text and URL, so it is checked, not trusted:
 * the picture must be an absolute http(s) URL (never `javascript:`, `data:` or a relative path), and the lengths are
 * capped (an emoticon's own name is at most 40 characters).
 */
export const emoticonRefSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(40),
  imageUrl: z.string().min(1).max(2048).refine(isHttpUrl, "not an absolute http(s) URL"),
});

/** The text an older server shows for an emoticon reaction it does not understand: `:name:`, within its 32-character limit. */
export function emoticonFallbackText(name: string): string {
  return `:${name}:`.slice(0, 32);
}

/**
 * The fields of a federated reaction: `emoji` for a Unicode one, or for an emoticon both `emoticon` and an `emoji`
 * text fallback. A server that predates custom reactions requires `emoji` and ignores what it does not know, so it
 * still gets something it accepts (shown as text, taken back by the same removal).
 */
export function reactionWire(kind: ReactionKind): { emoji: string; emoticon?: EmoticonRef } {
  if ("emoji" in kind) return { emoji: kind.emoji };
  return { emoji: emoticonFallbackText(kind.emoticon.name), emoticon: kind.emoticon };
}

/** The one reaction a federated request names. `emoticon`, when sent, wins over the `emoji` fallback that goes with it. */
export function reactionFromWire(data: { emoji?: string; emoticon?: EmoticonRef }): ReactionKind | null {
  if (data.emoticon) return { emoticon: data.emoticon };
  if (data.emoji) return { emoji: data.emoji };
  return null;
}

/** What identifies one reaction on a message: the same emoji, or the same emoticon. */
export function reactionKey(kind: ReactionKind): string {
  return "emoji" in kind ? `u:${kind.emoji}` : `e:${kind.emoticon.id}`;
}

/** A federated reaction request's emoji and/or emoticon (at least one), used by every add/remove endpoint. */
export const wireReactionShape = {
  emoji: z.string().min(1).max(32).optional(),
  emoticon: emoticonRefSchema.optional(),
};

export const hasReaction = (data: { emoji?: string; emoticon?: EmoticonRef }) => !!(data.emoji || data.emoticon);
