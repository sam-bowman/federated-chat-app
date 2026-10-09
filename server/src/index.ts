import http from "node:http";
import { join } from "node:path";
import { config, installDir, isPackagedBinary } from "./config.js";
import { prisma } from "./db.js";
import { app } from "./app.js";
import { createWebSocketGateway } from "./ws/gateway.js";
import { applyPendingMigrations } from "./standaloneMigrate.js";
import { startFederationOutboxWorker } from "./lib/federation/outbox.js";

const httpServer = http.createServer(app);
createWebSocketGateway(httpServer);
const stopFederationOutboxWorker = startFederationOutboxWorker();

async function main() {
  await prisma.$connect();

  // Docker/dev apply migrations via the real `prisma migrate deploy` CLI
  // (docker-entrypoint.sh / scripts/start.ps1) - the packaged binary
  // doesn't ship that CLI at all (see DISTRIBUTION.md "Native binaries"),
  // so it applies them itself here instead, the one time this matters.
  if (isPackagedBinary()) {
    const migrationsDir = join(installDir, "prisma", "migrations");
    const applied = await applyPendingMigrations(prisma, migrationsDir);
    if (applied.length > 0) {
      console.log(`Applied migrations: ${applied.join(", ")}`);
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
  console.error("Fatal startup error:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  stopFederationOutboxWorker();
  await prisma.$disconnect();
  process.exit(0);
});
