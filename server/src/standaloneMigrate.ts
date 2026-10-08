import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";

// Applies prisma/migrations/*/migration.sql directly via @prisma/client's
// own connection, used only by the packaged-binary distribution (see
// DISTRIBUTION.md "Native binaries") - it doesn't ship the `prisma` CLI at
// all (its migration engine is a separate native binary with its own
// SEA-loading question nobody needed to answer, once this exists). Docker
// and dev keep using the real CLI's `migrate deploy` exactly as before;
// this is purely additive.
//
// Writes a `_prisma_migrations` row with the exact shape the real CLI
// would (same columns, a checksum of the actual file content, a
// `finished_at`), so a database migrated this way stays fully compatible
// with the real CLI later - e.g. if someone moves from the binary
// distribution to Docker, `prisma migrate deploy` sees these as already
// applied instead of re-running or complaining about drift.

const MIGRATIONS_TABLE = `"_prisma_migrations"`;

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

function listMigrationNames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(); // timestamp-prefixed directory names sort chronologically
}

async function ensureMigrationsTable(prisma: PrismaClient): Promise<void> {
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
async function appliedMigrationNames(prisma: PrismaClient): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
    `SELECT migration_name FROM ${MIGRATIONS_TABLE} WHERE finished_at IS NOT NULL`
  );
  return new Set(rows.map((row) => row.migration_name));
}

/** Applies any not-yet-recorded migration in `migrationsDir`, in order. Returns the names actually applied. */
export async function applyPendingMigrations(prisma: PrismaClient, migrationsDir: string): Promise<string[]> {
  await ensureMigrationsTable(prisma);
  const applied = await appliedMigrationNames(prisma);

  const newlyApplied: string[] = [];
  for (const name of listMigrationNames(migrationsDir)) {
    if (applied.has(name)) continue;

    const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
    for (const statement of splitStatements(sql)) {
      await prisma.$executeRawUnsafe(statement);
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO ${MIGRATIONS_TABLE} (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES ($1, $2, now(), $3, now(), 1)`,
      randomUUID(),
      checksumFor(sql),
      name
    );

    newlyApplied.push(name);
  }

  return newlyApplied;
}
