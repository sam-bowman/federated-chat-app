// What the server's own migrator (src/standaloneMigrate.ts) has to do now that it, and not `prisma migrate deploy`, runs at every start of the Docker
// image: apply each migration whole or not at all, apply it once when several replicas start together, refuse a migration the CLI left half done, and
// (src/migrate.ts, what docker-entrypoint.sh runs) make a missing database only when asked to and say clearly when it cannot reach one.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { createDatabaseIfMissing, databaseNameOf, quoteIdentifier } from "../../src/lib/databaseCreate.js";
import { createPrismaClient } from "../../src/lib/prismaClient.js";
import { UnfinishedMigrationError, applyPendingMigrations } from "../../src/standaloneMigrate.js";

const DATABASE_URL = new URL(process.env.DATABASE_URL!);
const PG_BASE = `${DATABASE_URL.protocol}//${DATABASE_URL.username}:${DATABASE_URL.password}@${DATABASE_URL.host}`;
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");
const SERVER_DIR = path.resolve(import.meta.dirname, "../..");
const TSX = path.resolve(SERVER_DIR, "../node_modules/tsx/dist/cli.mjs");
const SUFFIX = randomUUID().replace(/-/g, "_").slice(0, 10);
const HOOK_TIMEOUT_MS = 120_000;

const created: string[] = [];
const name = (label: string) => {
  const dbName = `migrate_safety_${label}_${SUFFIX}`;
  created.push(dbName);
  return dbName;
};
const make = (dbName: string) => prisma.$executeRawUnsafe(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
afterAll(async () => {
  for (const dbName of created) await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)} WITH (FORCE)`);
}, HOOK_TIMEOUT_MS);

const folders: string[] = [];
/** A migrations folder of our own: each entry is a migration's name and its SQL. */
function migrationsOf(sqls: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "migrations-"));
  folders.push(dir);
  for (const [migration, sql] of Object.entries(sqls)) {
    mkdirSync(path.join(dir, migration));
    writeFileSync(path.join(dir, migration, "migration.sql"), sql);
  }
  return dir;
}
afterAll(() => folders.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const tables = (client: ReturnType<typeof createPrismaClient>) =>
  client.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`).then((rows) => rows.map((r) => r.table_name));

describe("a migration is applied whole or not at all", () => {
  const dbName = name("atomic");
  beforeAll(() => make(dbName), HOOK_TIMEOUT_MS);

  it("rolls a failing migration back, keeps the ones before it, says which failed, and applies it once it is fixed", async () => {
    const client = createPrismaClient(`${PG_BASE}/${dbName}`);
    try {
      const broken = migrationsOf({
        "20260101000000_first": `CREATE TABLE "first_one" ("id" INTEGER NOT NULL);`,
        // The first statement succeeds and the second cannot: the table it made must not be left behind.
        "20260102000000_second": `CREATE TABLE "second_one" ("id" INTEGER NOT NULL);\nINSERT INTO "no_such_table" VALUES (1);`,
        "20260103000000_third": `CREATE TABLE "third_one" ("id" INTEGER NOT NULL);`,
      });
      await expect(applyPendingMigrations(client, broken)).rejects.toThrow(/20260102000000_second failed and was rolled back/);
      expect(await tables(client)).toEqual(["_prisma_migrations", "first_one"]);
      const rows = await client.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null }[]>(`SELECT migration_name, finished_at FROM "_prisma_migrations"`);
      expect(rows.map((r) => r.migration_name)).toEqual(["20260101000000_first"]);
      expect(rows[0].finished_at).not.toBeNull();

      // Nothing half done to repair: the same database takes the corrected migration and the one after it.
      const fixed = migrationsOf({
        "20260101000000_first": `CREATE TABLE "first_one" ("id" INTEGER NOT NULL);`,
        "20260102000000_second": `CREATE TABLE "second_one" ("id" INTEGER NOT NULL);`,
        "20260103000000_third": `CREATE TABLE "third_one" ("id" INTEGER NOT NULL);`,
      });
      expect(await applyPendingMigrations(client, fixed)).toEqual(["20260102000000_second", "20260103000000_third"]);
      expect(await tables(client)).toEqual(["_prisma_migrations", "first_one", "second_one", "third_one"]);
    } finally {
      await client.$disconnect();
    }
  });
});

describe("several replicas starting at once", () => {
  const dbName = name("race");
  beforeAll(() => make(dbName), HOOK_TIMEOUT_MS);

  it("apply every migration exactly once between them, and leave one row for each", async () => {
    const clients = [1, 2, 3].map(() => createPrismaClient(`${PG_BASE}/${dbName}`));
    try {
      const results = await Promise.all(clients.map((client) => applyPendingMigrations(client, MIGRATIONS_DIR)));
      const all = results.flat();
      expect(new Set(all).size).toBe(all.length);
      const rows = await clients[0].$queryRawUnsafe<{ migration_name: string }[]>(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`);
      expect(rows).toHaveLength(all.length);
      expect(new Set(rows.map((r) => r.migration_name)).size).toBe(rows.length);
      expect(all.length).toBeGreaterThan(20);
      // And a start after that has nothing to do.
      expect(await applyPendingMigrations(clients[1], MIGRATIONS_DIR)).toEqual([]);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  }, 90_000);
});

describe("a migration the CLI left half done", () => {
  const dbName = name("unfinished");
  beforeAll(() => make(dbName), HOOK_TIMEOUT_MS);

  it("stops everything and says which, rather than running more on top of it", async () => {
    const client = createPrismaClient(`${PG_BASE}/${dbName}`);
    try {
      const first = migrationsOf({ "20260101000000_first": `CREATE TABLE "first_one" ("id" INTEGER NOT NULL);` });
      await applyPendingMigrations(client, first);
      // What `prisma migrate deploy` leaves when a migration fails: a row that was started and never finished.
      await client.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('stuck', 'x', '20260102000000_stuck', now(), 0)`
      );
      const next = migrationsOf({
        "20260101000000_first": `CREATE TABLE "first_one" ("id" INTEGER NOT NULL);`,
        "20260103000000_third": `CREATE TABLE "third_one" ("id" INTEGER NOT NULL);`,
      });
      const refused = applyPendingMigrations(client, next);
      await expect(refused).rejects.toBeInstanceOf(UnfinishedMigrationError);
      await expect(refused).rejects.toThrow("started and never finished (20260102000000_stuck)");
      expect(await tables(client)).toEqual(["_prisma_migrations", "first_one"]);
    } finally {
      await client.$disconnect();
    }
  });
});

describe("making the database", () => {
  it("names it from the URL, and quotes the name so that nothing in it can end the statement", () => {
    expect(databaseNameOf("postgresql://u:p@h:5432/chat?schema=public")).toBe("chat");
    expect(databaseNameOf("postgresql://u:p@h/with%20space")).toBe("with space");
    expect(() => databaseNameOf("postgresql://u:p@h:5432")).toThrow(/does not name a database/);
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
    expect(quoteIdentifier('x"; DROP DATABASE chat; --')).toBe('"x""; DROP DATABASE chat; --"');
  });

  it("makes a missing one once, and says false when it is already there", async () => {
    const dbName = name("create");
    const url = `${PG_BASE}/${dbName}`;
    expect(await createDatabaseIfMissing(url)).toBe(true);
    expect(await createDatabaseIfMissing(url)).toBe(false);
    const client = createPrismaClient(url);
    try {
      await expect(client.$queryRawUnsafe(`select 1 as ok`)).resolves.toEqual([{ ok: 1 }]);
    } finally {
      await client.$disconnect();
    }
  });

  it("copes with a name that needs quoting", async () => {
    const dbName = `${name("quoted")}"x`;
    created.push(dbName);
    expect(await createDatabaseIfMissing(`${PG_BASE}/${encodeURIComponent(dbName)}`)).toBe(true);
    const found = await prisma.$queryRawUnsafe<{ datname: string }[]>(`SELECT datname FROM pg_database WHERE datname = $1`, dbName);
    expect(found).toHaveLength(1);
  });
});

describe("the entrypoint's script (dist/migrate.js, here through tsx)", () => {
  const run = (url: string | undefined, extra: Record<string, string> = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    delete env.DATABASE_URL;
    if (url) env.DATABASE_URL = url;
    return spawnSync(process.execPath, [TSX, "src/migrate.ts"], { cwd: SERVER_DIR, env, encoding: "utf8", timeout: 90_000 });
  };

  it("migrates a database, then finds it up to date", () => {
    const dbName = name("script");
    // CREATE_DATABASE_IF_MISSING also makes it, which is the other thing this is for.
    const first = run(`${PG_BASE}/${dbName}`, { CREATE_DATABASE_IF_MISSING: "true" });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`Created the database "${dbName}"`);
    expect(first.stdout).toContain("Applied migrations: ");
    const second = run(`${PG_BASE}/${dbName}`, { CREATE_DATABASE_IF_MISSING: "true" });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("The database is up to date.");
    expect(second.stdout).not.toContain("Created the database");
  }, 120_000);

  it("does not make a missing database unless told to: it fails, naming the problem, and leaves no database behind", async () => {
    const dbName = name("missing");
    const result = run(`${PG_BASE}/${dbName}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not apply the database migrations");
    const found = await prisma.$queryRawUnsafe<{ datname: string }[]>(`SELECT datname FROM pg_database WHERE datname = $1`, dbName);
    expect(found).toHaveLength(0);
  }, 120_000);

  it("says plainly when it cannot reach the database, or when there is no URL", () => {
    const unreachable = run("postgresql://chat:chat@127.0.0.1:1/chat");
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toContain("Could not apply the database migrations");
    const none = run(undefined);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("DATABASE_URL is not set");
  }, 120_000);
});
