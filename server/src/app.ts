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
import { authLimiter, generalLimiter } from "./middleware/rateLimit.js";
import { Router } from "./lib/asyncRouter.js";
import { corsOptions } from "./lib/corsOrigins.js";

// Pure Express app wiring, with no `listen()` call - split out from index.ts
// so tests (supertest) can exercise real routes/middleware against a real
// database without binding a port or starting the WebSocket gateway.
export const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// Mounted before the app-wide CORS policy below, deliberately - .well-known
// carries its own permissive CORS (see wellknown.ts) since discovery has to
// work for a browser on any origin, by design, before any client has picked
// this as its home server. Everything else stays behind the configured
// CORS_ORIGIN list.
app.use(wellKnownRouter);

app.use(cors(corsOptions(config.corsOrigins)));
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

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Covers every route mounted below (both /api/v1 and /federation/v1) with
// one general limiter; /healthz and wellKnownRouter above aren't behind it
// (neither was flagged by CodeQL's js/missing-rate-limiting, and the
// wellknown document needs to stay reachable for the home-server picker).
app.use(generalLimiter);

const api = Router();
api.use("/auth", authLimiter, authRouter);
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

// Last in the chain, so it catches whatever the routes above hand to next(err):
// a handler that threw, a rejected promise from an async handler (see
// lib/asyncRouter.ts), or a failure in body parsing. Without it Express answers
// with an HTML page.
//
// Client errors keep their status (malformed JSON is a 400, an oversized body a
// 413) in the API's own `{ error }` shape. Anything else is a 500 whose detail is
// logged here, with the request line, and never sent to the client.
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return res.status(status).json({ error: status === 413 ? "payload_too_large" : "invalid_request" });
  }
  // A constant format string with the request parts as arguments: the URL is
  // attacker-controlled, and console.error treats its first argument as a
  // printf-style format (CodeQL js/tainted-format-string).
  console.error("[http] %s %s failed:", req.method, req.originalUrl, err);
  res.status(500).json({ error: "internal_error" });
});
