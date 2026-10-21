import http from "node:http";
import { join } from "node:path";
import { config, configuredEnv, installDir, isPackagedBinary } from "./config.js";
import { describePolicy } from "./lib/federationPolicy.js";
import { prisma } from "./db.js";
import { app } from "./app.js";
import { closeGatewayConnections, createWebSocketGateway } from "./ws/gateway.js";
import { startPresenceMaintenance } from "./ws/presenceMaintenance.js";
import { runShutdown } from "./lib/shutdown.js";
import { applyPendingMigrations } from "./standaloneMigrate.js";
import { startFederationOutboxWorker } from "./lib/federation/outbox.js";
import { startAccountDeletionWorker } from "./modules/users/deletion.js";
import { databaseSummary } from "./lib/databaseTarget.js";
import { describeRepair, repairLocalHomeserverDomains } from "./lib/localDomainRepair.js";
import {
  StartupError,
  appliedMigrationsUnknownToThisVersion,
  uploadsDirWarning,
  decideInsecureDefaults,
  newerDatabaseMessage,
} from "./startupChecks.js";

const httpServer = http.createServer(app);
createWebSocketGateway(httpServer);
const stopFederationOutboxWorker = startFederationOutboxWorker();
// Erases accounts whose grace period is over (#60). Looks again every hour; see modules/users/deletion.ts.
const stopAccountDeletionWorker = startAccountDeletionWorker();
let stopPresenceMaintenance: () => Promise<void> = async () => {};

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

  // Local accounts and communities that an old migration tagged 'localhost' (it could not
  // know this server's domain) are invisible to login and lookups on a real domain; give
  // them the real one. A no-op on a fresh database or a server that really is localhost.
  for (const line of describeRepair(await repairLocalHomeserverDomains(prisma, config.domain), config.domain)) {
    if (line.startsWith("WARNING")) console.warn(line);
    else console.log(line);
  }

  // Say which database this is and whether it holds anything: a server pointed at the wrong
  // (or a new, empty) database starts perfectly happily, so this line is what makes it visible.
  console.log(databaseSummary(config.databaseUrl, await prisma.user.count({ where: { isRemote: false } })));

  // The disk storage driver writes straight into UPLOADS_DIR; say so now if it can't,
  // instead of leaving the first user to upload something to find out.
  if (config.storageDriver === "disk") {
    const warning = uploadsDirWarning(config.uploadsDir);
    if (warning) console.warn(warning);
  }

  // Clear presence left over from before this start. With several replicas that must not touch
  // users who are connected to the others - see ws/presenceMaintenance.ts.
  stopPresenceMaintenance = await startPresenceMaintenance();

  if (!config.federationEnabled) {
    console.log("Federation is OFF (FEDERATION_ENABLED=false): this server is private. It answers no other server and sends nothing to one.");
  } else {
    const limit = describePolicy(config.federationPolicy);
    if (limit) console.log(`Federation is limited (FEDERATION_ALLOWED_DOMAINS / FEDERATION_BLOCKED_DOMAINS): this server ${limit}.`);
  }

  if (config.voice.enabled) {
    console.log(`Voice channels are on (LiveKit at ${config.voice.url}).`);
  }

  if (!config.registrationEnabled) {
    console.log("Registration is OFF (REGISTRATION_ENABLED=false): nobody can make an account here.");
  } else if (config.registrationInviteOnly) {
    console.log("Registration is invite-only (REGISTRATION_INVITE_ONLY): an account needs a code. Make one with: node dist/registrationInvitesCli.js create");
  }

  httpServer.listen(config.port, () => {
    console.log(`[${config.serverName}] listening on :${config.port} (domain=${config.domain})`);
  });
}

main().catch((err) => {
  if (err instanceof StartupError) console.error(err.message);
  else console.error("Fatal startup error:", err);
  process.exit(1);
});

// Graceful shutdown. On Kubernetes the pod is first removed from the Service (the chart's
// preStop delay gives the ingress time to notice), then this runs: stop taking new
// connections, tell every WebSocket client we are going away so it reconnects elsewhere,
// let in-flight requests finish, then stop the background work and the database. Each step is
// bounded and the whole thing is capped, so a stuck client cannot keep the pod from stopping.
let shuttingDown = false;
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;

  const hardStop = setTimeout(() => {
    console.error("[shutdown] did not finish in time, exiting anyway");
    process.exit(1);
  }, 20_000);
  hardStop.unref();

  const serverClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
  httpServer.closeIdleConnections();

  runShutdown(
    [
      { name: "close WebSocket connections", run: () => closeGatewayConnections() },
      { name: "finish in-flight requests", run: () => serverClosed },
      {
        name: "stop background work",
        run: async () => {
          stopFederationOutboxWorker();
          stopAccountDeletionWorker();
          await stopPresenceMaintenance();
        },
      },
      { name: "disconnect the database", run: () => prisma.$disconnect() },
    ],
    8_000
  ).finally(() => process.exit(0));
});
