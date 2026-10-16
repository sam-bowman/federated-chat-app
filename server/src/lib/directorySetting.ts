// DIRECTORY_ENABLED: whether this server publishes a directory of its PUBLIC communities and the people who chose to be listed
// (#109, phase 5). Off by default, so nothing is published until the operator says so; on, anyone can browse it, the server's own
// people and, through their own servers, other servers'.
//
// Strict like FEDERATION_ENABLED: only the usual spellings of yes and no are accepted and anything else stops the server at startup,
// because a typo here would publish (or hide) something the operator did not mean to.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

const YES = new Set(["true", "1", "yes", "on"]);
const NO = new Set(["false", "0", "no", "off"]);

/** Parses `DIRECTORY_ENABLED`. Unset or empty means off; `true`/`1`/`yes`/`on` mean on, `false`/`0`/`no`/`off` off, any case; anything else throws. */
export function parseDirectoryEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || NO.has(value)) return false;
  if (YES.has(value)) return true;
  throw new Error(
    `DIRECTORY_ENABLED is "${raw}", which is not true or false. Use false (the default) or true; a value that could be a typo is refused rather than guessed, because it decides whether this server publishes a list of its communities and people.`
  );
}
