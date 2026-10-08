import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/db.js";
import { applyPendingMigrations, splitStatements } from "../../src/standaloneMigrate.js";

// Derived from DATABASE_URL (set by test/setupEnv.ts locally, by ci.yml in
// CI) rather than hardcoded - local dev maps Postgres to port 5433 to
// avoid clashing with a pre-existing local install, but CI's service
// container uses the standard 5432. Hardcoding either one here would pass
// in exactly one of the two environments and fail in the other.
const DATABASE_URL = new URL(process.env.DATABASE_URL!);
const PG_BASE = `${DATABASE_URL.protocol}//${DATABASE_URL.username}:${DATABASE_URL.password}@${DATABASE_URL.host}`;
const SCHEMA_PATH = path.resolve(import.meta.dirname, "../../prisma/schema.prisma");
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");
const PRISMA_CLI = path.resolve(import.meta.dirname, "../../../node_modules/prisma/build/index.js");

async function createDatabase(name: string) {
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
}

async function dropDatabase(name: string) {
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
}

function introspect(client: PrismaClient) {
  return Promise.all([
    client.$queryRawUnsafe<{ table_name: string; column_name: string; data_type: string }[]>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' ORDER BY table_name, column_name`
    ),
    client.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`
    ),
    // Excludes constraint_type = 'CHECK' - Postgres represents a column's
    // NOT NULL as an implicit CHECK constraint auto-named from internal,
    // per-database table OIDs (e.g. "2200_160399_3_not_null"), which
    // differ between any two separately-created databases regardless of
    // migration method, even two real `prisma migrate deploy` runs. Actual
    // Prisma-assigned constraints (PRIMARY KEY/FOREIGN KEY/UNIQUE) have
    // deterministic names and are what's worth comparing here.
    client.$queryRawUnsafe<{ constraint_name: string }[]>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND constraint_type != 'CHECK' ORDER BY constraint_name`
    ),
  ]);
}

describe("splitStatements", () => {
  it("splits plain statements on semicolons", () => {
    expect(splitStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("does not split on a semicolon inside a quoted string", () => {
    expect(splitStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`)).toEqual([
      `INSERT INTO t VALUES ('a;b');`,
      "SELECT 1;",
    ]);
  });

  it("does not split on a semicolon inside a dollar-quoted function body", () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END; $$ LANGUAGE plpgsql; SELECT 1;`;
    expect(splitStatements(sql)).toEqual([
      `CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END; $$ LANGUAGE plpgsql;`,
      "SELECT 1;",
    ]);
  });

  it("does not split on a semicolon inside a tagged dollar-quoted block", () => {
    const sql = `DO $body$ BEGIN RAISE NOTICE 'a;b'; END; $body$; SELECT 1;`;
    expect(splitStatements(sql)).toEqual([`DO $body$ BEGIN RAISE NOTICE 'a;b'; END; $body$;`, "SELECT 1;"]);
  });

  it("ignores a semicolon inside a line comment", () => {
    expect(splitStatements(`-- a;b comment\nSELECT 1;`)).toEqual([`-- a;b comment\nSELECT 1;`]);
  });
});

// Regression-relevant: applyPendingMigrations exists specifically because
// the packaged binary distribution doesn't ship the `prisma` CLI (see
// CLAUDE.md) - but the database it produces still needs to be
// indistinguishable from one migrated by the real CLI, or a self-hoster
// who later moves from the binary to Docker would hit broken `migrate
// deploy` drift errors. This runs both against separate fresh databases
// and diffs the actual resulting schema, not just "did it not throw."
describe("applyPendingMigrations vs. the real CLI", () => {
  const suffix = randomUUID().replace(/-/g, "_").slice(0, 12);
  const cliDbName = `standalone_migrate_cli_${suffix}`;
  const runnerDbName = `standalone_migrate_runner_${suffix}`;

  beforeAll(async () => {
    await createDatabase(cliDbName);
    await createDatabase(runnerDbName);
  });

  afterAll(async () => {
    await dropDatabase(cliDbName);
    await dropDatabase(runnerDbName);
  });

  it("produces a schema identical to the real CLI's migrate deploy", async () => {
    execFileSync(
      process.execPath,
      [PRISMA_CLI, "migrate", "deploy", "--schema", SCHEMA_PATH],
      { env: { ...process.env, DATABASE_URL: `${PG_BASE}/${cliDbName}` }, stdio: "pipe" }
    );

    const runnerClient = new PrismaClient({ datasources: { db: { url: `${PG_BASE}/${runnerDbName}` } } });
    try {
      const applied = await applyPendingMigrations(runnerClient, MIGRATIONS_DIR);
      expect(applied.length).toBeGreaterThan(0);

      const cliClient = new PrismaClient({ datasources: { db: { url: `${PG_BASE}/${cliDbName}` } } });
      try {
        const [cliSchema, runnerSchema] = await Promise.all([introspect(cliClient), introspect(runnerClient)]);
        expect(runnerSchema).toEqual(cliSchema);

        const [cliMigrations, runnerMigrations] = await Promise.all([
          cliClient.$queryRawUnsafe<{ migration_name: string }[]>(
            `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name`
          ),
          runnerClient.$queryRawUnsafe<{ migration_name: string }[]>(
            `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name`
          ),
        ]);
        expect(runnerMigrations).toEqual(cliMigrations);
      } finally {
        await cliClient.$disconnect();
      }
    } finally {
      await runnerClient.$disconnect();
    }
  });

  it("is idempotent - re-running applies nothing new", async () => {
    const runnerClient = new PrismaClient({ datasources: { db: { url: `${PG_BASE}/${runnerDbName}` } } });
    try {
      const applied = await applyPendingMigrations(runnerClient, MIGRATIONS_DIR);
      expect(applied).toEqual([]);
    } finally {
      await runnerClient.$disconnect();
    }
  });
});
