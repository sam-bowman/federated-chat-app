import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import { config } from "./config.js";
import { wellKnownRouter } from "./wellknown.js";
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
import { federationRouter } from "./modules/federation/routes.js";

// Pure Express app wiring, with no `listen()` call - split out from index.ts
// so tests (supertest) can exercise real routes/middleware against a real
// database without binding a port or starting the WebSocket gateway.
export const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(
  express.json({
    limit: "1mb",
    // Federation signatures are computed over the exact request bytes the
    // sender signed - re-serializing req.body could reorder keys/whitespace
    // and break verification, so capture the raw string alongside it.
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  })
);
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

app.use("/federation/v1", federationRouter);

app.use((_req, res) => res.status(404).json({ error: "not_found" }));
