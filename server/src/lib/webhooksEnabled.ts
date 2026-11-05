// WEBHOOKS_ENABLED switches incoming webhooks (#132, phase 2) on or off: making them, and accepting what is posted to one. On by default,
// because a webhook gives nobody anything until a community's manager (who holds MANAGE_WEBHOOKS) makes one. Off stops every existing webhook
// at once (a post is a 404) without deleting anything, for an operator who does not want programs posting.
//
// Strict like the other switches that guard something: only the usual spellings of yes and no are accepted and anything else stops the
// server at startup, because "fasle" quietly leaving webhooks ON is the cost of a typo here.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

const YES = new Set(["true", "1", "yes", "on"]);
const NO = new Set(["false", "0", "no", "off"]);

/** Parses `WEBHOOKS_ENABLED`. Unset or empty means on; `true`/`1`/`yes`/`on` and `false`/`0`/`no`/`off` (any case) are accepted; anything else throws. */
export function parseWebhooksEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || YES.has(value)) return true;
  if (NO.has(value)) return false;
  throw new Error(
    `WEBHOOKS_ENABLED is "${raw}", which is not true or false. Use false to switch incoming webhooks off, or true (the default); a value that could be a typo is refused rather than guessed.`
  );
}

/** Parses `WEBHOOKS_PER_COMMUNITY_LIMIT`: how many webhooks one community may have. Unset means 10; a whole number from 0 (none may be made) to 100. */
export function parseWebhooksPerCommunityLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 10;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`WEBHOOKS_PER_COMMUNITY_LIMIT is "${raw}", which is not a whole number from 0 to 100.`);
  }
  return value;
}
