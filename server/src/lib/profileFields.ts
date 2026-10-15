/**
 * The optional fields of a person's profile, and what to do with the ones another server sends. Every
 * field is untrusted text: the local ones come from the person who owns the profile (and are shown
 * to everyone else), the remote ones from another homeserver, so each is checked here before it is
 * stored or sent on. Pure, so it is unit tested; used by PATCH /users/me and by the profile route.
 */
import { isIconUrl, sanitizeIconColor } from "./communityIcon.js";

export const PRONOUNS_MAX_CHARACTERS = 32;
export const DISPLAY_NAME_MAX_CHARACTERS = 64;
export const BIO_MAX_CHARACTERS = 512;

// Control characters and line/paragraph separators.
const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const LINE_BREAKS_AND_TABS = /[\n\r\t]/g;

function characterCount(text: string): number {
  // As a person counts them (an emoji with a skin tone is one), not UTF-16 units.
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false };

/** Pronouns as typed: trimmed, and empty means none. Invalid if too long or containing control characters. */
export function parsePronouns(value: unknown): Parsed<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const text = value.trim();
  if (text === "") return { ok: true, value: null };
  if (UNSAFE_TEXT.test(text) || characterCount(text) > PRONOUNS_MAX_CHARACTERS) return { ok: false };
  return { ok: true, value: text };
}

/** An accent colour as typed: "#rrggbb" (any case, stored lower case), or null for none. */
export function parseAccentColor(value: unknown): Parsed<string | null> {
  if (value === null) return { ok: true, value: null };
  const colour = sanitizeIconColor(value);
  return colour ? { ok: true, value: colour } : { ok: false };
}

/** The profile fields another server may tell us about someone, each already safe to store. */
export interface RemoteProfileFields {
  /** Undefined when the peer sent nothing usable, so the cached name is kept rather than blanked. */
  displayName: string | undefined;
  avatarUrl: string | null;
  bio: string | null;
  pronouns: string | null;
  accentColor: string | null;
}

/**
 * Reads the profile fields out of what a peer returned for one of its users. Anything that is missing
 * (an older peer that has no pronouns), the wrong type, too long or containing control characters
 * becomes null, never an error: a peer cannot make a profile fail to load by sending something odd.
 */
export function sanitizeRemoteProfile(raw: unknown): RemoteProfileFields {
  const user = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  const name = typeof user.displayName === "string" ? user.displayName.trim() : "";
  const displayName =
    name !== "" && !UNSAFE_TEXT.test(name) && characterCount(name) <= DISPLAY_NAME_MAX_CHARACTERS ? name : undefined;

  // A bio keeps its line breaks and tabs, so those are set aside before looking for control characters.
  const bio =
    typeof user.bio === "string" &&
    user.bio.trim() !== "" &&
    user.bio.length <= BIO_MAX_CHARACTERS &&
    !UNSAFE_TEXT.test(user.bio.replace(LINE_BREAKS_AND_TABS, ""))
      ? user.bio
      : null;

  const pronouns = parsePronouns(user.pronouns);
  const accent = parseAccentColor(user.accentColor);

  return {
    displayName,
    // A path under the peer's uploads is kept as a path: the stub makes it absolute against the peer's own address.
    avatarUrl: isIconUrl(user.avatarUrl) ? user.avatarUrl : null,
    bio,
    pronouns: pronouns.ok ? pronouns.value : null,
    accentColor: accent.ok ? accent.value : null,
  };
}
