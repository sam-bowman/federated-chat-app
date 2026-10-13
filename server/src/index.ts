import http from "node:http";
import { join } from "node:path";
import { config, configuredEnv, installDir, isPackagedBinary } from "./config.js";
import { prisma } from "./db.js";
import { app } from "./app.js";
import { createWebSocketGateway } from "./ws/gateway.js";
import { applyPendingMigrations } from "./standaloneMigrate.js";
import { startFederationOutboxWorker } from "./lib/federation/outbox.js";
import {
  StartupError,
  appliedMigrationsUnknownToThisVersion,
  decideInsecureDefaults,
  newerDatabaseMessage,
} from "./startupChecks.js";

const httpServer = http.createServer(app);
createWebSocketGateway(httpServer);
const stopFederationOutboxWorker = startFederationOutboxWorker();

async function main() {
  // Before anything else, so a misconfigured deployment fails without needing
  // the database. The Docker image and the packaged binaries are the two ways
  // people deploy; `npm run dev` is neither.
  const insecure = decideInsecureDefaults(
    { ...configuredEnv, ALLOW_INSECURE_DEFAULTS: process.env.ALLOW_INSECURE_DEFAULTS },
    process.env.NODE_ENV === "production" || isPackagedBinary()
  );
  if (insecure.fatal) throw new StartupError(insecure.fatal);
  if (insecure.warning) console.warn(insecure.warning);

  await prisma.$connect();

  // Docker/dev apply migrations via the real `prisma migrate deploy` CLI
  // (docker-entrypoint.sh / scripts/start.ps1) - the packaged binary
  // doesn't ship that CLI at all (see docs/distribution.md "Native binaries"),
  // so it applies them itself here instead, the one time this matters.
  if (isPackagedBinary()) {
    const migrationsDir = join(installDir, "prisma", "migrations");
    const applied = await applyPendingMigrations(prisma, migrationsDir);
    if (applied.length > 0) {
      console.log(`Applied migrations: ${applied.join(", ")}`);
    }
  }

  // Migrations only move forward, so a database that a newer version has
  // already migrated is not safe to run older code against - it would start,
  // answer /healthz, and fail on whatever request touches a changed column.
  // By now this version has applied everything it knows (Docker: the entrypoint
  // ran `migrate deploy`; binary: just above; dev: start.ps1), so anything still
  // unknown in the table came from a newer version.
  const migrationsDir = join(isPackagedBinary() ? installDir : process.cwd(), "prisma", "migrations");
  const unknown = await appliedMigrationsUnknownToThisVersion(prisma, migrationsDir);
  if (unknown === null) {
    console.warn(`Could not check the database against this version's migrations (looked in ${migrationsDir}).`);
  } else if (unknown.length > 0) {
    if (process.env.ALLOW_UNKNOWN_MIGRATIONS === "true") {
      console.warn(
        `WARNING: the database has ${unknown.length} migration(s) this version does not know about (${unknown.join(", ")}). ` +
          "Starting anyway because ALLOW_UNKNOWN_MIGRATIONS=true."
      );
    } else {
      throw new StartupError(newerDatabaseMessage(unknown));
    }
  }

  // There are, by definition, zero live WebSocket connections the instant
  // this process starts - presence is tracked purely in-memory per process,
  // so any "ONLINE" left over from before a restart (dev reload, deploy,
  // crash) is stale and would otherwise never self-correct, since there's no
  // live socket left to close or fail a heartbeat. Reconnecting clients flip
  // themselves back to ONLINE within seconds anyway.
  await prisma.user.updateMany({
    where: { presenceStatus: { not: "OFFLINE" } },
    data: { presenceStatus: "OFFLINE", lastSeenAt: new Date() },
  });

  httpServer.listen(config.port, () => {
    console.log(`[${config.serverName}] listening on :${config.port} (domain=${config.domain})`);
  });
}

main().catch((err) => {
  if (err instanceof StartupError) console.error(err.message);
  else console.error("Fatal startup error:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  stopFederationOutboxWorker();
  await prisma.$disconnect();
  process.exit(0);
});
