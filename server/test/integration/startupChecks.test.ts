import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { appliedMigrationsUnknownToThisVersion } from "../../src/startupChecks.js";
import { disconnectDb } from "../helpers/db.js";

afterAll(disconnectDb);

const FUTURE = "29991231235959_from_a_newer_version";
const migrationsDir = join(process.cwd(), "prisma", "migrations");

afterEach(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name = $1`, FUTURE);
});

// The scenario behind "refuse to start against a newer database": an older
// version (a rolled-back image, `helm rollback`, an old binary) pointed at a
// database a newer version has already migrated used to start normally and fail
// later, per request. This runs the real query against the real
// _prisma_migrations table the integration database was migrated with.
describe("appliedMigrationsUnknownToThisVersion (real database)", () => {
  it("finds nothing unknown when the database was migrated by this version", async () => {
    expect(await appliedMigrationsUnknownToThisVersion(prisma, migrationsDir)).toEqual([]);
  });

  it("reports a migration this version does not ship", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES ($1, $2, now(), $3, now(), 1)`,
      "00000000-0000-0000-0000-000000000083",
      "0".repeat(64),
      FUTURE
    );
    expect(await appliedMigrationsUnknownToThisVersion(prisma, migrationsDir)).toEqual([FUTURE]);
  });

  it("ignores a migration that started but never finished", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES ($1, $2, NULL, $3, now(), 0)`,
      "00000000-0000-0000-0000-000000000084",
      "0".repeat(64),
      FUTURE
    );
    expect(await appliedMigrationsUnknownToThisVersion(prisma, migrationsDir)).toEqual([]);
  });
});
