// ACCOUNT_DELETION_GRACE_DAYS: how long an account whose owner asked to delete it waits before it is erased (#60). In that time
// signing in cancels it, which is the whole point: a stolen session or a mistake must not be permanent in one click.
//
// Strict like the other settings that guard something: a number of whole days from 0 to 365, anything else refuses startup rather than
// being guessed (a typo such as "7d" quietly becoming 14 would change when people's data is erased). 0 means no waiting: an account is
// erased the next time the worker looks (within the hour), for a server that wants it that way. Unset means 14.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

export const DEFAULT_GRACE_DAYS = 14;
export const MAX_GRACE_DAYS = 365;

/** Parses `ACCOUNT_DELETION_GRACE_DAYS`. Unset or empty is the default (14); otherwise a whole number of days from 0 to 365, or it throws. */
export function parseAccountDeletionGraceDays(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_GRACE_DAYS;
  if (!/^\d{1,3}$/u.test(value) || Number(value) > MAX_GRACE_DAYS) {
    throw new Error(
      `ACCOUNT_DELETION_GRACE_DAYS is "${raw}", which is not a whole number of days from 0 to ${MAX_GRACE_DAYS}. It is how long an account waits, after its owner asks to delete it, before it is erased (default ${DEFAULT_GRACE_DAYS}); a value that could be a typo is refused rather than guessed.`
    );
  }
  return Number(value);
}

/** When an account whose deletion was asked for at `requestedAt` is erased. */
export function purgeDate(requestedAt: Date, graceDays: number): Date {
  return new Date(requestedAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
}
