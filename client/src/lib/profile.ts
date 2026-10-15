import type { CSSProperties } from "react";

/** The longest pronouns the server accepts, in characters as a person counts them. */
export const PRONOUNS_MAX = 32;
/** The longest bio the server accepts. */
export const BIO_MAX = 512;

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** Whether a value is exactly "#rrggbb", the only shape of colour ever let into a style. */
export function isHexColour(value: string | null | undefined): value is string {
  return typeof value === "string" && HEX_COLOUR.test(value);
}

/**
 * The profile accent colour as a CSS custom property, or nothing. It is user data (and, for someone on another
 * server, a stranger's), so only exactly #rrggbb is ever let into a style.
 */
export function accentStyle(accent: string | null | undefined): CSSProperties | undefined {
  return isHexColour(accent) ? ({ "--profile-accent": accent } as CSSProperties) : undefined;
}

/** "Member since March 2025", or null if the date is missing or not a date. */
export function memberSinceText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `Member since ${new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date)}`;
}
