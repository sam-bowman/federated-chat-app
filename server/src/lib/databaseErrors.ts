/**
 * Is this the error for "the database named in DATABASE_URL does not exist"? Prisma 5's engine reported it as `P1003` from `$connect()`.
 * Prisma 7 talks to Postgres through the `pg` driver, `$connect()` no longer opens a connection, and the first query fails as a raw-query
 * error (`P2010`) whose `meta` carries what the driver said: the kind `DatabaseDoesNotExist`, and Postgres's own code `3D000`.
 * Anything else (an unreachable server, a wrong password) is not this, and is left to say what it is in its own words.
 */
export function isMissingDatabase(err: unknown): boolean {
  const cause = (err as { meta?: { driverAdapterError?: { cause?: { kind?: unknown; originalCode?: unknown } } } } | null)?.meta?.driverAdapterError?.cause;
  return cause?.kind === "DatabaseDoesNotExist" || cause?.originalCode === "3D000";
}
