import { PrismaClient } from "@prisma/client";
import { missingDatabaseMessage } from "./lib/databaseTarget.js";

// Run by docker-entrypoint.sh BEFORE `prisma migrate deploy`. The migrate CLI creates a
// database that does not exist and carries on, so a typo in the database name at the end
// of DATABASE_URL became a new, empty database: the server started normally, with a
// fresh federation identity, and everything looked deleted. The native binaries already
// fail with "Database ... does not exist" (their client connects without the CLI), and
// this makes the container behave the same way. Set CREATE_DATABASE_IF_MISSING=true to
// keep the old behaviour (the entrypoint then skips this script).
//
// It only reacts to the one error that means "no such database" (P1003). An unreachable
// server or bad credentials are reported by `prisma migrate deploy` and the server
// themselves, in their usual words, so they are left to them.

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
  } catch (err) {
    if ((err as { errorCode?: string }).errorCode === "P1003") {
      console.error(missingDatabaseMessage(databaseUrl));
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
