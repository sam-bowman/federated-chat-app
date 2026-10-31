import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "./generated/prisma/client.js";
import { bcryptRoundsProblem } from "./lib/bcryptRounds.js";
import { listMigrationNames } from "./standaloneMigrate.js";

// Two checks that run once, before the server starts listening. Both exist
// because the failure they prevent is silent: the server would start, look
// healthy, and be wrong - running on public development secrets, or running
// against a database a newer version has already changed. Pure functions plus
// one thin database query, so the decisions are unit-testable without booting
// the server; index.ts decides what to do with the answers.

/** An error whose message is the whole story - printed without a stack trace. */
export class StartupError extends Error {}

// Values that must never sign real tokens: the built-in fallbacks in config.ts
// and the placeholders in server/.env.example. All of them are public.
const PLACEHOLDER_SECRETS = new Set([
  "dev-insecure-access-secret-change-me",
  "dev-insecure-refresh-secret-change-me",
  "change-me-to-a-long-random-string",
  "change-me-to-a-different-long-random-string",
]);

/** Human-readable problems with the configuration; empty when it is safe. */
export function insecureDefaultProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  for (const name of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"]) {
    const value = env[name];
    if (value === undefined || value === "") {
      problems.push(`${name} is not set - the built-in development secret is public, so anyone could forge login tokens`);
    } else if (PLACEHOLDER_SECRETS.has(value)) {
      problems.push(`${name} is still a placeholder value from the examples - it is public, so anyone could forge login tokens`);
    }
  }
  const weakHashing = bcryptRoundsProblem(env.BCRYPT_ROUNDS);
  if (weakHashing) problems.push(weakHashing);
  if (env.SERVER_DOMAIN === undefined || env.SERVER_DOMAIN === "") {
    problems.push(
      "SERVER_DOMAIN is not set, so it defaults to 'localhost' - it becomes part of every user id (@user:domain) and cannot be changed later"
    );
  }
  return problems;
}

export interface InsecureDefaultsDecision {
  /** Set when the server must not start. */
  fatal?: string;
  /** Set when it may start but the operator should be told. */
  warning?: string;
}

/**
 * `productionLike` is true for the Docker image (NODE_ENV=production) and the
 * packaged binaries - the two ways people deploy - and false for `npm run dev`
 * and tests. `ALLOW_INSECURE_DEFAULTS=true` downgrades a refusal to a warning,
 * for a throwaway local trial of the image.
 */
export function decideInsecureDefaults(env: NodeJS.ProcessEnv, productionLike: boolean): InsecureDefaultsDecision {
  const problems = insecureDefaultProblems(env);
  if (problems.length === 0) return {};
  const list = problems.map((p) => `  - ${p}`).join("\n");

  if (productionLike && env.ALLOW_INSECURE_DEFAULTS !== "true") {
    return {
      fatal:
        `Refusing to start: this looks like a deployment (NODE_ENV=production or a packaged binary), but the server is not configured safely:\n${list}\n` +
        "Set them - see docs/deployment/ - or set ALLOW_INSECURE_DEFAULTS=true to start anyway (a throwaway local trial only).",
    };
  }
  return {
    warning:
      `WARNING: insecure configuration - fine for local development, never for a deployment:\n${list}` +
      (productionLike ? "\n(Starting anyway because ALLOW_INSECURE_DEFAULTS=true.)" : ""),
  };
}

/** Names in `applied` that are not in `known`, in the order given. */
export function unknownMigrations(applied: string[], known: string[]): string[] {
  const knownSet = new Set(known);
  return applied.filter((name) => !knownSet.has(name));
}

/**
 * Migrations recorded as applied in the database that this version does not
 * ship - i.e. a newer version has already migrated it. Returns null when the
 * check cannot be made (no migrations folder next to this version, or no
 * `_prisma_migrations` table yet), which callers treat as "nothing to say".
 */
export async function appliedMigrationsUnknownToThisVersion(
  prisma: Pick<PrismaClient, "$queryRawUnsafe">,
  migrationsDir: string
): Promise<string[] | null> {
  if (!existsSync(migrationsDir)) return null;
  let rows: { migration_name: string }[];
  try {
    rows = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
    );
  } catch {
    return null; // table does not exist yet: a brand-new database
  }
  return unknownMigrations(
    rows.map((row) => row.migration_name),
    listMigrationNames(migrationsDir)
  );
}

export function newerDatabaseMessage(unknown: string[]): string {
  return (
    `Refusing to start: the database has ${unknown.length} migration(s) this version does not know about:\n` +
    unknown.map((name) => `  - ${name}`).join("\n") +
    "\nIt was migrated by a newer version, and running older code against it fails unpredictably (a request that touches a " +
    "changed table or column errors). Upgrade this server to that version or newer, or restore a database backup taken before " +
    "the upgrade - see docs/deployment/upgrading-and-backups.md. To start anyway, set ALLOW_UNKNOWN_MIGRATIONS=true."
  );
}

/**
 * A warning when the uploads directory cannot be written by this process, or null when it can.
 *
 * Tries to actually create a file rather than asking the OS about permissions, because that is
 * what an upload does and it also catches read-only mounts. The server image runs as a
 * non-root user, and many storage drivers (Longhorn among them) hand out a new volume owned by
 * root with mode 755, so on Kubernetes the first sign used to be a user's upload failing with
 * EACCES. A warning, not a refusal: chat works without uploads, and a deployment using the
 * "s3" storage driver never gets here.
 */
export function uploadsDirWarning(dir: string): string | null {
  const probe = join(dir, `.write-test-${process.pid}`);
  try {
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    return (
      `WARNING: the uploads directory (${dir}) is not writable by this server process (${code}), so every upload ` +
      "(avatars, attachments, emoticon images) will fail. The server runs as a non-root user: make the volume writable " +
      "for it - on Kubernetes keep the chart's server.podSecurityContext.fsGroup (kubelet does not apply it to " +
      "ReadWriteMany volumes), with Docker chown the mounted directory - or set STORAGE_DRIVER=s3. " +
      "See docs/deployment/kubernetes.md."
    );
  }
}
