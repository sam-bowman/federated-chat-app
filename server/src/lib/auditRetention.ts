// AUDIT_LOG_RETENTION_DAYS: how long the audit log (#59) keeps an entry. Older ones are deleted by a daily pass, so the log does not grow for
// ever. 0 keeps everything. Strict, like the grace period for deleting accounts: a whole number of days from 0 to 3650, anything else
// refuses startup rather than being guessed (a typo such as "90d" quietly becoming a year would change what an operator can look back on).
//
// Kept free of config.ts imports so it can be unit-tested on its own.

export const DEFAULT_RETENTION_DAYS = 365;
export const MAX_RETENTION_DAYS = 3650;

/** Parses `AUDIT_LOG_RETENTION_DAYS`. Unset or empty is the default (365); otherwise a whole number of days from 0 (keep for ever) to 3650, or it throws. */
export function parseAuditRetentionDays(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_RETENTION_DAYS;
  if (!/^\d{1,4}$/u.test(value) || Number(value) > MAX_RETENTION_DAYS) {
    throw new Error(
      `AUDIT_LOG_RETENTION_DAYS is "${raw}", which is not a whole number of days from 0 to ${MAX_RETENTION_DAYS}. It is how long the audit log keeps an entry (default ${DEFAULT_RETENTION_DAYS}, 0 keeps them for ever); a value that could be a typo is refused rather than guessed.`
    );
  }
  return Number(value);
}
