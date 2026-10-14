// The bcrypt work factor for new password hashes (BCRYPT_ROUNDS). Pure, like the other src/lib
// helpers, so config.ts and the startup checks can both use it.
//
// Cost 12 is the default and what a real deployment should run: each extra round doubles the time an
// attacker with a leaked database needs per guess. It is configurable for one reason: the integration
// tests register hundreds of users, and at cost 12 the pure-JavaScript bcryptjs spends most of a
// suite's time hashing, so test/setupEnv.ts runs them at the minimum. Hashes made at another cost keep
// verifying, since the cost is stored in the hash itself.

export const DEFAULT_BCRYPT_ROUNDS = 12;
/** bcrypt's own limits. */
export const MIN_BCRYPT_ROUNDS = 4;
export const MAX_BCRYPT_ROUNDS = 31;
/** Below this, a deployment is warned (and a production-like start refused): passwords would be cheap to crack. */
export const MIN_SAFE_BCRYPT_ROUNDS = 10;

/** Unset or empty means the default; anything else must be a whole number bcrypt accepts. */
export function parseBcryptRounds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BCRYPT_ROUNDS;
  const trimmed = raw.trim();
  const rounds = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(rounds) || rounds < MIN_BCRYPT_ROUNDS || rounds > MAX_BCRYPT_ROUNDS) {
    throw new Error(
      `BCRYPT_ROUNDS must be a whole number from ${MIN_BCRYPT_ROUNDS} to ${MAX_BCRYPT_ROUNDS} (default ${DEFAULT_BCRYPT_ROUNDS}), got "${raw}".`
    );
  }
  return rounds;
}

/** The problem to report for a work factor too low for real use, or null. */
export function bcryptRoundsProblem(raw: string | undefined): string | null {
  const rounds = parseBcryptRounds(raw);
  if (rounds >= MIN_SAFE_BCRYPT_ROUNDS) return null;
  return `BCRYPT_ROUNDS=${rounds} is below ${MIN_SAFE_BCRYPT_ROUNDS} - password hashes would be cheap to crack if the database leaked (it exists for the test suite; leave it unset, which means ${DEFAULT_BCRYPT_ROUNDS})`;
}
