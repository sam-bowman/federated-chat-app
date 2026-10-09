// Split out from outbox.ts purely so this pure formula can be unit-tested
// in isolation - outbox.ts itself transitively imports config.js (via
// client.ts), which throws on missing DATABASE_URL in the plain
// unit-test environment (see CLAUDE.md's note on server/src/lib/storage/
// for the same reasoning applied there).

/** Exponential backoff in ms for the given attempt count (1-indexed), capped at maxDelayMs. */
export function backoffMs(attempts: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempts - 1));
}
