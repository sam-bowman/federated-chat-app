// ADMIN_ENABLED switches the admin page and its API (/admin, /api/v1/admin/*, #206) on or off. On by default: it exposes nothing until the
// operator makes an admin with the command line, and answers 404 to everyone else, so a server that never makes one has no admin surface.
// Off removes it entirely, for an operator who wants the command line only. The command line is unaffected either way.
//
// Strict like the other switches that guard something: only the usual spellings of yes and no are accepted and anything else stops the
// server at startup, because "fasle" quietly leaving the admin surface ON is the cost of a typo here.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

const YES = new Set(["true", "1", "yes", "on"]);
const NO = new Set(["false", "0", "no", "off"]);

/** Parses `ADMIN_ENABLED`. Unset or empty means on; `true`/`1`/`yes`/`on` and `false`/`0`/`no`/`off` (any case) are accepted; anything else throws. */
export function parseAdminEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || YES.has(value)) return true;
  if (NO.has(value)) return false;
  throw new Error(
    `ADMIN_ENABLED is "${raw}", which is not true or false. Use false to switch the admin page and its API off, or true (the default); a value that could be a typo is refused rather than guessed.`
  );
}
