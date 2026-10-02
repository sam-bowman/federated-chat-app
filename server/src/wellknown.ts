import { Router } from "express";
import { config } from "./config.js";

export const wellKnownRouter = Router();

// Minimal server-discovery document (spec §26). Lets a client learn what a
// homeserver supports before logging in, and gives future federation peers a
// place to discover this server's capabilities without a central registry.
wellKnownRouter.get("/.well-known/communication-platform", (_req, res) => {
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
      federation: false,
      e2ee: false,
    },
  });
});
