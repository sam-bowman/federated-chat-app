// The "details" of an audit log entry (#59) are a few plain facts about what was done: which fields of a community changed, the name of a role.
// They are written by code in this server, but they end up in a log an operator reads and in a column that must stay small, so they are
// reduced to a safe shape on the way in: short strings, numbers, booleans, and short lists of short strings. Anything else is dropped, never
// cut into something that looks valid. Never put what a person wrote (a message, a ban reason) or a secret in them: the caller's job, and
// the reason this takes no object it could not describe.
//
// Kept free of config.ts and database imports so it can be unit-tested on its own.

export type AuditDetails = Record<string, string | number | boolean | null | string[]>;

export const MAX_DETAIL_KEYS = 12;
export const MAX_KEY_LENGTH = 40;
export const MAX_STRING_LENGTH = 200;
export const MAX_LIST_ITEMS = 20;
export const MAX_LIST_ITEM_LENGTH = 60;

const cut = (text: string, max: number) => (text.length <= max ? text : `${[...text].slice(0, max - 1).join("")}…`);
// A control, format or separator character has no business in a label an operator reads (a bidirectional override can reorder it).
const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();

/** The details in the shape the log keeps, or null when nothing is left of them. */
export function sanitizeDetails(details: Record<string, unknown> | undefined | null): AuditDetails | null {
  if (!details) return null;
  const out: AuditDetails = {};
  for (const [key, value] of Object.entries(details)) {
    if (Object.keys(out).length >= MAX_DETAIL_KEYS) break;
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(key)) continue;
    if (typeof value === "string") out[key] = cut(clean(value), MAX_STRING_LENGTH);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out[key] = (value as string[]).slice(0, MAX_LIST_ITEMS).map((v) => cut(clean(v), MAX_LIST_ITEM_LENGTH));
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A label for the thing an action was done to, as the log shows it: one short clean line. */
export function sanitizeLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const text = cut(clean(label), MAX_STRING_LENGTH);
  return text === "" ? null : text;
}
