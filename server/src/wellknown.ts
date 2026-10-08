import { Router } from "express";
import cors from "cors";
import { config } from "./config.js";
import { getServerKeyPair } from "./lib/federation/keys.js";

export const wellKnownRouter = Router();

// Minimal server-discovery document (spec §26). Lets a client learn what a
// homeserver supports before logging in, and gives federation peers a place
// to discover this server's capabilities and signing key without a central
// registry.
//
// Deliberately its own permissive CORS, separate from the app-wide
// CORS_ORIGIN policy (app.ts mounts this router before that middleware) -
// a browser-based home-server picker needs to query this document from an
// arbitrary domain the user just typed in, which by definition isn't yet
// in any configured origin allowlist. The response carries no secrets (the
// signing key is meant to be public) and the route reads no cookies, so an
// open `Access-Control-Allow-Origin: *` is the correct, minimal-risk policy
// here - every other route stays behind the single configured origin.
wellKnownRouter.use(cors());

wellKnownRouter.get("/.well-known/communication-platform", async (_req, res) => {
  const { publicKey } = await getServerKeyPair();
  res.json({
    protocolVersion: config.protocolVersion,
    domain: config.domain,
    serverName: config.serverName,
    apiBase: "/api/v1",
    websocketPath: "/ws",
    registration: {
      enabled: config.registrationEnabled,
    },
    features: {
      friends: true,
      directMessages: true,
      groupDms: true,
      presence: true,
      communities: true,
      emoticons: true,
      voice: false,
      federation: true,
      e2ee: false,
    },
    federation: {
      enabled: true,
      apiBase: "/federation/v1",
      publicKey,
    },
  });
});
