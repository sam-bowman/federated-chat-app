import { join } from "node:path";
import { createDatabaseIfMissing, databaseNameOf } from "./lib/databaseCreate.js";
import { isMissingDatabase } from "./lib/databaseErrors.js";
import { createPrismaClient } from "./lib/prismaClient.js";
import { applyPendingMigrations } from "./standaloneMigrate.js";

// Run by docker-entrypoint.sh before the server starts: brings the database up to this version's schema, the job `prisma migrate deploy` used to do
// there. The image has no `prisma` CLI any more (it brought Studio and a dev server, more than doubling node_modules), so the server's own
// migrator does it: src/standaloneMigrate.ts, the same one the native binaries use, which takes a lock so replicas starting together are safe.
//
// Reads only DATABASE_URL (and CREATE_DATABASE_IF_MISSING), like checkDatabaseExists.ts, not config.ts: the JWT secrets and the rest are not its business.
// A missing database is refused by checkDatabaseExists.ts before this runs, unless CREATE_DATABASE_IF_MISSING=true says to make it (below).

/** Prisma wraps a database error in a few lines naming the call that failed; what the person needs is the last one ("... Message: `password authentication failed for user ...`"). */
function whyItFailed(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? text;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set, so there is no database to migrate.");
  process.exitCode = 1;
} else {
  const prisma = createPrismaClient(databaseUrl);
  try {
    if (process.env.CREATE_DATABASE_IF_MISSING === "true") {
      try {
        await prisma.$queryRaw`select 1`;
      } catch (err) {
        if (!isMissingDatabase(err)) throw err;
        if (await createDatabaseIfMissing(databaseUrl)) console.log(`Created the database "${databaseNameOf(databaseUrl)}" (CREATE_DATABASE_IF_MISSING=true).`);
      }
    }
    const applied = await applyPendingMigrations(prisma, join(process.cwd(), "prisma", "migrations"));
    console.log(applied.length > 0 ? `Applied migrations: ${applied.join(", ")}` : "The database is up to date.");
  } catch (err) {
    console.error("Could not apply the database migrations:", whyItFailed(err));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
