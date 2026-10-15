import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

/**
 * In front of every /federation/v1/* route. On a private server (FEDERATION_ENABLED=false) the request is refused
 * before anything is done with it: no signature check, which would have fetched the caller's discovery document, no
 * nonce recorded, no route run. The answer is the same for every caller, so it says nothing about who is asking.
 */
export function requireFederationEnabled(_req: Request, res: Response, next: NextFunction) {
  if (!config.federationEnabled) return res.status(403).json({ error: "federation_disabled" });
  next();
}
