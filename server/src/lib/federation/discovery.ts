import { prisma } from "../../db.js";
import { config } from "../../config.js";

export interface ResolvedPeer {
  domain: string;
  baseUrl: string;
  apiBase: string; // federation API base, e.g. "/federation/v1"
  publicKey: string;
}

const PEER_CACHE_TTL_MS = 10 * 60 * 1000;
const inFlight = new Map<string, Promise<ResolvedPeer>>();

/**
 * Resolves a homeserver domain to its reachable base URL + federation
 * signing public key, via its .well-known document - caching the result
 * (both in-memory for the process lifetime and in FederationPeer so a
 * restart doesn't force every peer to be re-discovered cold).
 */
export async function resolvePeer(domain: string): Promise<ResolvedPeer> {
  const cached = await prisma.federationPeer.findUnique({ where: { domain } });
  if (cached && Date.now() - cached.fetchedAt.getTime() < PEER_CACHE_TTL_MS) {
    return { domain, baseUrl: cached.baseUrl, apiBase: "/federation/v1", publicKey: cached.publicKey };
  }

  const existingFetch = inFlight.get(domain);
  if (existingFetch) return existingFetch;

  const fetchPromise = fetchAndCachePeer(domain).finally(() => inFlight.delete(domain));
  inFlight.set(domain, fetchPromise);
  return fetchPromise;
}

async function fetchAndCachePeer(domain: string): Promise<ResolvedPeer> {
  const overrideBaseUrl = config.federationPeerOverrides[domain];
  const baseUrl = overrideBaseUrl ?? `https://${domain}`;

  const res = await fetch(`${baseUrl}/.well-known/communication-platform`);
  if (!res.ok) throw new Error(`discovery_failed:${domain}:${res.status}`);
  const doc = (await res.json()) as {
    federation?: { enabled?: boolean; apiBase?: string; publicKey?: string };
  };

  if (!doc.federation?.enabled || !doc.federation?.publicKey) {
    throw new Error(`peer_not_federated:${domain}`);
  }

  await prisma.federationPeer.upsert({
    where: { domain },
    create: { domain, baseUrl, publicKey: doc.federation.publicKey },
    update: { baseUrl, publicKey: doc.federation.publicKey, fetchedAt: new Date() },
  });

  return {
    domain,
    baseUrl,
    apiBase: doc.federation.apiBase ?? "/federation/v1",
    publicKey: doc.federation.publicKey,
  };
}
