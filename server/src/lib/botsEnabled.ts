// BOTS_ENABLED switches bot accounts (#132) on or off: creating them, and accepting their tokens. On by default, because making a bot gives
// nobody anything until a community's manager adds it, and each person may only have a few (BOTS_PER_USER_LIMIT). Off stops every existing bot
// at once (its token is refused) without deleting anything, for an operator who does not want programs on the server.
//
// Strict like the other switches that guard something: only the usual spellings of yes and no are accepted and anything else stops the
// server at startup, because "fasle" quietly leaving bots ON is the cost of a typo here.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

const YES = new Set(["true", "1", "yes", "on"]);
const NO = new Set(["false", "0", "no", "off"]);

/** Parses `BOTS_ENABLED`. Unset or empty means on; `true`/`1`/`yes`/`on` and `false`/`0`/`no`/`off` (any case) are accepted; anything else throws. */
export function parseBotsEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || YES.has(value)) return true;
  if (NO.has(value)) return false;
  throw new Error(
    `BOTS_ENABLED is "${raw}", which is not true or false. Use false to switch bot accounts off, or true (the default); a value that could be a typo is refused rather than guessed.`
  );
}

/** Parses `BOTS_PER_USER_LIMIT`: how many bots one person may have. Unset means 5; a whole number from 0 (nobody may make one) to 50. */
export function parseBotsPerUserLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 5;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 50) {
    throw new Error(`BOTS_PER_USER_LIMIT is "${raw}", which is not a whole number from 0 to 50.`);
  }
  return value;
}
