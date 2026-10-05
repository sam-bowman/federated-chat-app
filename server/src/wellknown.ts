import { Router } from "express";
import { config } from "./config.js";
import { getServerKeyPair } from "./lib/federation/keys.js";

export const wellKnownRouter = Router();

// Minimal server-discovery document (spec §26). Lets a client learn what a
// homeserver supports before logging in, and gives federation peers a place
// to discover this server's capabilities and signing key without a central
// registry.
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
