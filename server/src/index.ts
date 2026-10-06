import http from "node:http";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { app } from "./app.js";
import { createWebSocketGateway } from "./ws/gateway.js";

const httpServer = http.createServer(app);
createWebSocketGateway(httpServer);

async function main() {
  await prisma.$connect();

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
  await prisma.$disconnect();
  process.exit(0);
});
