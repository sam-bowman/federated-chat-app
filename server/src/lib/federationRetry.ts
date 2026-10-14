// FEDERATION_RETRY_BASE_MS: the pause between the in-request retries of one outbound federation call
// (src/lib/federation/client.ts retries up to 3 times, waiting 1x then 2x this). Pure, like the other src/lib
// helpers, so config.ts can use it. Not meant to be tuned in a deployment (the outbox's own backoff, which
// is in minutes, is what handles a peer that is really down); it exists so tests need not sleep.

export const DEFAULT_FEDERATION_RETRY_BASE_MS = 500;
const MAX_FEDERATION_RETRY_BASE_MS = 10_000;

/** Unset or blank means the default; anything else must be a whole number of milliseconds from 0 to 10000. */
export function parseFederationRetryBaseMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_FEDERATION_RETRY_BASE_MS;
  const trimmed = raw.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(ms) || ms > MAX_FEDERATION_RETRY_BASE_MS) {
    throw new Error(
      `FEDERATION_RETRY_BASE_MS must be a whole number of milliseconds from 0 to ${MAX_FEDERATION_RETRY_BASE_MS} (default ${DEFAULT_FEDERATION_RETRY_BASE_MS}), got "${raw}".`
    );
  }
  return ms;
}
