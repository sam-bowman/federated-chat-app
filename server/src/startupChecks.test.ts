import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appliedMigrationsUnknownToThisVersion,
  decideInsecureDefaults,
  insecureDefaultProblems,
  newerDatabaseMessage,
  uploadsDirWarning,
  unknownMigrations,
} from "./startupChecks.js";

const SAFE_ENV = {
  SERVER_DOMAIN: "chat.example.com",
  JWT_ACCESS_SECRET: "a-long-random-access-secret-value",
  JWT_REFRESH_SECRET: "a-different-long-random-refresh-secret",
} as NodeJS.ProcessEnv;

describe("insecureDefaultProblems", () => {
  it("is empty for a configured server", () => {
    expect(insecureDefaultProblems(SAFE_ENV)).toEqual([]);
  });

  it("flags unset secrets and an unset domain", () => {
    const problems = insecureDefaultProblems({});
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("JWT_ACCESS_SECRET is not set");
    expect(problems.join("\n")).toContain("JWT_REFRESH_SECRET is not set");
    expect(problems.join("\n")).toContain("SERVER_DOMAIN is not set");
  });

  it("treats an empty string like an unset variable", () => {
    expect(insecureDefaultProblems({ ...SAFE_ENV, JWT_ACCESS_SECRET: "", SERVER_DOMAIN: "" })).toHaveLength(2);
  });

  it("flags the placeholders copied from server/.env.example, and the built-in fallbacks", () => {
    const problems = insecureDefaultProblems({
      ...SAFE_ENV,
      JWT_ACCESS_SECRET: "change-me-to-a-long-random-string",
      JWT_REFRESH_SECRET: "dev-insecure-refresh-secret-change-me",
    });
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("placeholder");
  });

  it("accepts an explicit SERVER_DOMAIN of localhost - only an unset one is an accident", () => {
    expect(insecureDefaultProblems({ ...SAFE_ENV, SERVER_DOMAIN: "localhost" })).toEqual([]);
  });
});

describe("decideInsecureDefaults", () => {
  it("says nothing when the configuration is safe, in either mode", () => {
    expect(decideInsecureDefaults(SAFE_ENV, true)).toEqual({});
    expect(decideInsecureDefaults(SAFE_ENV, false)).toEqual({});
  });

  it("refuses to start a deployment with insecure defaults, naming every problem", () => {
    const decision = decideInsecureDefaults({}, true);
    expect(decision.warning).toBeUndefined();
    expect(decision.fatal).toContain("Refusing to start");
    expect(decision.fatal).toContain("JWT_ACCESS_SECRET");
    expect(decision.fatal).toContain("SERVER_DOMAIN");
    expect(decision.fatal).toContain("ALLOW_INSECURE_DEFAULTS=true");
  });

  it("only warns in development", () => {
    const decision = decideInsecureDefaults({}, false);
    expect(decision.fatal).toBeUndefined();
    expect(decision.warning).toContain("WARNING");
  });

  it("lets ALLOW_INSECURE_DEFAULTS=true turn the refusal into a warning", () => {
    const decision = decideInsecureDefaults({ ALLOW_INSECURE_DEFAULTS: "true" }, true);
    expect(decision.fatal).toBeUndefined();
    expect(decision.warning).toContain("ALLOW_INSECURE_DEFAULTS=true");
  });

  it("does not treat other values of ALLOW_INSECURE_DEFAULTS as consent", () => {
    expect(decideInsecureDefaults({ ALLOW_INSECURE_DEFAULTS: "1" }, true).fatal).toBeDefined();
  });
});

describe("unknownMigrations", () => {
  it("returns only the applied names this version does not ship", () => {
    expect(unknownMigrations(["001_a", "002_b", "003_c"], ["001_a", "002_b"])).toEqual(["003_c"]);
    expect(unknownMigrations(["001_a"], ["001_a", "002_b"])).toEqual([]);
    expect(unknownMigrations([], [])).toEqual([]);
  });
});

describe("newerDatabaseMessage", () => {
  it("names the migrations and the way out", () => {
    const message = newerDatabaseMessage(["20990101000000_future"]);
    expect(message).toContain("1 migration(s)");
    expect(message).toContain("20990101000000_future");
    expect(message).toContain("upgrading-and-backups.md");
    expect(message).toContain("ALLOW_UNKNOWN_MIGRATIONS=true");
  });
});

describe("appliedMigrationsUnknownToThisVersion", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function migrationsDirWith(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "migrations-"));
    dirs.push(dir);
    for (const name of names) mkdirSync(join(dir, name));
    return dir;
  }

  const prismaReturning = (names: string[]) =>
    ({ $queryRawUnsafe: async () => names.map((migration_name) => ({ migration_name })) }) as never;

  it("reports migrations applied in the database but missing from this version", async () => {
    const dir = migrationsDirWith(["001_a", "002_b"]);
    expect(await appliedMigrationsUnknownToThisVersion(prismaReturning(["001_a", "002_b", "003_c"]), dir)).toEqual(["003_c"]);
  });

  it("reports nothing when the database is behind or level with this version", async () => {
    const dir = migrationsDirWith(["001_a", "002_b"]);
    expect(await appliedMigrationsUnknownToThisVersion(prismaReturning(["001_a", "002_b"]), dir)).toEqual([]);
    expect(await appliedMigrationsUnknownToThisVersion(prismaReturning(["001_a"]), dir)).toEqual([]);
  });

  it("cannot check without a migrations folder, and says so with null", async () => {
    expect(await appliedMigrationsUnknownToThisVersion(prismaReturning(["001_a"]), join(tmpdir(), "does-not-exist-xyz"))).toBeNull();
  });

  it("treats a missing _prisma_migrations table (a brand-new database) as nothing to say", async () => {
    const dir = migrationsDirWith(["001_a"]);
    const failing = {
      $queryRawUnsafe: async () => {
        throw new Error('relation "_prisma_migrations" does not exist');
      },
    } as never;
    expect(await appliedMigrationsUnknownToThisVersion(failing, dir)).toBeNull();
  });
});

describe("uploadsDirWarning", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is null for a directory the process can write to, and leaves nothing behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-"));
    dirs.push(dir);
    expect(uploadsDirWarning(dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("explains an unwritable directory, naming the directory, the error and the fix", () => {
    // A path that is a file, not a directory: creating anything under it fails on every platform.
    const dir = mkdtempSync(join(tmpdir(), "uploads-"));
    dirs.push(dir);
    const notADirectory = join(dir, "a-file");
    writeFileSync(notADirectory, "x");
    const warning = uploadsDirWarning(notADirectory);
    expect(warning).toContain("WARNING");
    expect(warning).toContain(notADirectory);
    expect(warning).toMatch(/ENOTDIR|ENOENT/);
    expect(warning).toContain("fsGroup");
    expect(warning).toContain("STORAGE_DRIVER=s3");
  });
});
