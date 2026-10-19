import { Router } from "express";
import cors from "cors";
import { config } from "./config.js";
import { getServerKeyPair } from "./lib/federation/keys.js";
import { serverVersion } from "./lib/version.js";

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
// here - every other route stays behind the configured CORS_ORIGIN list.
// Scoped to /.well-known: mounted with no path, this would answer EVERY OPTIONS
// preflight on the server (including /api/v1/*) with a wildcard before the
// app-wide policy ever saw it.
wellKnownRouter.use("/.well-known", cors());

wellKnownRouter.get("/.well-known/communication-platform", async (_req, res) => {
  // No key is generated or read for a server that is not going to use it.
  const publicKey = config.federationEnabled ? (await getServerKeyPair()).publicKey : undefined;
  res.json({
    protocolVersion: config.protocolVersion,
    // The release of this server software, shown to users by the client. Informational only:
    // unlike protocolVersion it plays no part in federation compatibility.
    serverVersion,
    domain: config.domain,
    serverName: config.serverName,
    apiBase: "/api/v1",
    websocketPath: "/ws",
    registration: {
      enabled: config.registrationEnabled,
      // Whether a code is needed. Only means anything while registration is on; a client that predates it just doesn't ask.
      inviteOnly: config.registrationEnabled && config.registrationInviteOnly,
    },
    features: {
      friends: true,
      directMessages: true,
      groupDms: true,
      presence: true,
      communities: true,
      emoticons: true,
      voice: false,
      federation: config.federationEnabled,
      // Whether it publishes a directory of its public communities and the people who chose to be listed.
      directory: config.directoryEnabled,
      e2ee: false,
    },
    // A private server says so and offers nothing to connect to: no API base and no signing key, since nobody is meant
    // to call it. (This document itself must stay public: the client's server picker reads it.)
    federation: config.federationEnabled ? { enabled: true, apiBase: "/federation/v1", publicKey } : { enabled: false },
  });
});
