import express from "express";
import http from "node:http";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { wellKnownRouter } from "./wellknown.js";
import { createWebSocketGateway } from "./ws/gateway.js";
import { authRouter } from "./modules/auth/routes.js";
import { usersRouter } from "./modules/users/routes.js";
import { friendsRouter } from "./modules/friends/routes.js";
import { conversationsRouter } from "./modules/conversations/routes.js";
import { messagesRouter } from "./modules/messages/routes.js";
import { communitiesRouter } from "./modules/communities/routes.js";
import { channelsRouter } from "./modules/channels/routes.js";
import { emoticonsRouter } from "./modules/emoticons/routes.js";
import { mediaRouter } from "./modules/media/routes.js";
import { syncRouter } from "./modules/sync/routes.js";

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(path.resolve(config.uploadsDir)));

app.use(wellKnownRouter);

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const api = express.Router();
api.use("/auth", authRouter);
api.use("/users", usersRouter);
api.use("/friends", friendsRouter);
api.use("/conversations", conversationsRouter);
api.use("/messages", messagesRouter);
api.use("/communities", communitiesRouter);
api.use("/channels", channelsRouter);
api.use("/emoticons", emoticonsRouter);
api.use("/media", mediaRouter);
api.use("/sync", syncRouter);
app.use("/api/v1", api);

app.use((_req, res) => res.status(404).json({ error: "not_found" }));

const httpServer = http.createServer(app);
createWebSocketGateway(httpServer);

async function main() {
  await prisma.$connect();
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
