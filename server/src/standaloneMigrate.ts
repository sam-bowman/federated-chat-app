import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "./generated/prisma/client.js";

// Applies prisma/migrations/*/migration.sql directly through the app's own database connection, so neither the
// packaged binaries (docs/distribution.md "Native binaries") nor the Docker image need the `prisma` CLI at all:
// the image runs this at every start (src/migrate.ts, via docker-entrypoint.sh), which is what keeps its runtime
// free of the CLI and its Studio and dev-server dependencies (node_modules 163 MB instead of 390). Development
// still uses the real CLI's `migrate deploy` (scripts/start.ps1).
//
// What the CLI did that this must too, because several replicas of a server can start at once: each migration
// runs in ONE transaction together with its row in _prisma_migrations (so a failure part-way leaves nothing
// behind to repair, which the CLI could not promise), and takes a Postgres advisory lock first, so replicas
// starting together apply each migration once while the others wait, then find it done.
//
// Writes a `_prisma_migrations` row with the exact shape the real CLI
// would (same columns, a checksum of the actual file content, a
// `finished_at`), so a database migrated this way stays fully compatible
// with the real CLI later - e.g. if someone moves from the binary
// distribution to Docker, `prisma migrate deploy` sees these as already
// applied instead of re-running or complaining about drift.

const MIGRATIONS_TABLE = `"_prisma_migrations"`;

/** The advisory lock the migrations take (a number of our own: "chat migrations"). Released when the transaction ends. */
export const MIGRATION_LOCK_KEY = 726_531_388;

/** A migration can be long on a big table; Prisma's interactive transactions give up after 5 s by default. */
const MIGRATION_TRANSACTION = { timeout: 10 * 60_000, maxWait: 2 * 60_000 } as const;

/** A migration the CLI began and never finished is in the database: nothing is applied until someone has looked at it. */
export class UnfinishedMigrationError extends Error {}

/** What a migration needs from the client: the client itself, or the one inside a transaction. */
type Queryable = Pick<PrismaClient, "$executeRawUnsafe" | "$queryRawUnsafe">;

/**
 * Splits a migration.sql file into individual statements. Not a naive
 * semicolon split - Prisma's own query engine always uses the prepared
 * statement protocol (confirmed empirically: a multi-statement
 * $executeRawUnsafe call fails with "cannot insert multiple commands into
 * a prepared statement", even with zero parameters), so a full file has to
 * be split and each statement sent separately. This tracks single/double
 * quoted strings and $tag$-dollar-quoted blocks (used by function/trigger
 * bodies) so a semicolon inside either of those doesn't end the statement
 * early - a plain `.split(";")` would silently corrupt exactly that case.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    if (ch === "-" && sql[i + 1] === "-") {
      const lineEnd = sql.indexOf("\n", i);
      const stop = lineEnd === -1 ? n : lineEnd + 1;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    if (ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const delimiter = tagMatch[0];
        const closeIndex = sql.indexOf(delimiter, i + delimiter.length);
        const end = closeIndex === -1 ? n : closeIndex + delimiter.length;
        current += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === ";") {
      current += ch;
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

function checksumFor(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function listMigrationNames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(); // timestamp-prefixed directory names sort chronologically
}

async function ensureMigrationsTable(prisma: Queryable): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )
  `);
}

/** Names of migrations already recorded as successfully applied. */
async function appliedMigrationNames(prisma: Queryable): Promise<Set<string>> {
  // A database nobody has migrated has no table yet. Asked first (not CREATE TABLE IF NOT EXISTS), because two things creating it at once collide.
  const [{ exists }] = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(`SELECT to_regclass('${MIGRATIONS_TABLE}') IS NOT NULL AS exists`);
  if (!exists) return new Set();
  const rows = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
    `SELECT migration_name FROM ${MIGRATIONS_TABLE} WHERE finished_at IS NOT NULL`
  );
  return new Set(rows.map((row) => row.migration_name));
}

/**
 * Applies any not-yet-recorded migration in `migrationsDir`, in order. Returns the names actually applied. Safe to run from several processes at once,
 * and a migration that fails leaves nothing behind (it is rolled back, and the error says which one). A migration the CLI began and never finished
 * (a row with no finished_at and not rolled back) is refused rather than run again on top of whatever it left.
 */
export async function applyPendingMigrations(prisma: PrismaClient, migrationsDir: string): Promise<string[]> {
  const names = listMigrationNames(migrationsDir);
  // Asked once without the lock: at every start after the first, everything is applied and nothing below takes it.
  const alreadyApplied = await appliedMigrationNames(prisma);

  const newlyApplied: string[] = [];
  for (const name of names) {
    if (alreadyApplied.has(name)) continue;
    const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
    try {
      const applied = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
        await ensureMigrationsTable(tx);
        // Another process may have done it while this one waited for the lock.
        if ((await appliedMigrationNames(tx)).has(name)) return false;
        const unfinished = await tx.$queryRawUnsafe<{ migration_name: string }[]>(
          `SELECT migration_name FROM ${MIGRATIONS_TABLE} WHERE finished_at IS NULL AND rolled_back_at IS NULL`
        );
        if (unfinished.length > 0) {
          throw new UnfinishedMigrationError(
            `the database has a migration that was started and never finished (${unfinished.map((row) => row.migration_name).join(", ")}). ` +
              "Look at what it left, then mark it with `prisma migrate resolve` (from a checkout of this version, pointed at this database) before starting again."
          );
        }
        for (const statement of splitStatements(sql)) {
          await tx.$executeRawUnsafe(statement);
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO ${MIGRATIONS_TABLE} (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
           VALUES ($1, $2, now(), $3, now(), 1)`,
          randomUUID(),
          checksumFor(sql),
          name
        );
        return true;
      }, MIGRATION_TRANSACTION);
      if (applied) newlyApplied.push(name);
    } catch (err) {
      if (err instanceof UnfinishedMigrationError) throw err;
      throw new Error(`migration ${name} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  return newlyApplied;
}
