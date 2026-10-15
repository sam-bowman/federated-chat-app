import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

/**
 * In front of every /federation/v1/* route, after the on/off switch: a request from a server this one will not talk to
 * (FEDERATION_ALLOWED_DOMAINS / FEDERATION_BLOCKED_DOMAINS) is refused `403 federation_domain_blocked`.
 *
 * It judges the origin the caller CLAIMS, before the signature is checked, on purpose: checking the signature means fetching
 * that domain's discovery document, and a server on the block list (or off the allow list) is one this server does not
 * contact. That also means a forged origin can never make this server go and look anything up for a domain it does not
 * federate with. A forged claim costs nothing and gains nothing: anyone can claim to be a blocked domain and be refused, and
 * claiming to be a permitted one still has to pass the signature check that follows. The answer is the same for a blocked
 * domain and one that is merely not on the allow list, so it does not say which list is in use.
 */
export function requireFederationDomainPermitted(req: Request, res: Response, next: NextFunction) {
  const origin = req.header("X-Federation-Origin");
  if (origin && !config.federationPolicy.isPermitted(origin)) {
    return res.status(403).json({ error: "federation_domain_blocked" });
  }
  next();
}
