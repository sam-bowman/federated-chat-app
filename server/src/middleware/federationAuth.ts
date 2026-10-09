import type { NextFunction, Request, Response } from "express";
import { resolvePeer } from "../lib/federation/discovery.js";
import { verifySignature } from "../lib/federation/signing.js";
import { checkAndRecordNonce } from "../lib/federation/nonceCache.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      federationOrigin?: string;
      rawBody?: string;
    }
  }
}

/**
 * Verifies an inbound /federation/v1/* request was genuinely signed by the
 * domain it claims to be from. Fetches (and caches) that domain's public key
 * via its own .well-known document the first time we see it - this is
 * trust-on-first-discovery, not a central registry.
 */
export async function requireFederationAuth(req: Request, res: Response, next: NextFunction) {
  const origin = req.header("X-Federation-Origin");
  const timestamp = req.header("X-Federation-Timestamp");
  const signature = req.header("X-Federation-Signature");

  if (!origin || !timestamp || !signature) {
    return res.status(401).json({ error: "missing_federation_signature" });
  }

  let publicKey: string;
  try {
    publicKey = (await resolvePeer(origin)).publicKey;
  } catch {
    return res.status(401).json({ error: "unknown_or_unreachable_peer" });
  }

  const valid = verifySignature(publicKey, req.method, req.originalUrl, req.rawBody ?? "", timestamp, signature);
  if (!valid) {
    return res.status(401).json({ error: "invalid_federation_signature" });
  }

  // The signature is itself a valid nonce (unique per method/path/timestamp/
  // body, unforgeable without the origin's private key) - checked only now
  // that it's genuinely verified, so a forged request can't be used to
  // cheaply pollute the cache. A second request bearing the exact same
  // signature - a replay, not a fresh retry (a real retry re-signs with a
  // new timestamp) - is rejected even though it's still within the
  // timestamp window signing.ts already enforces above.
  const isFresh = await checkAndRecordNonce(signature);
  if (!isFresh) {
    return res.status(401).json({ error: "replayed_federation_request" });
  }

  req.federationOrigin = origin;
  next();
}
