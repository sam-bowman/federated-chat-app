import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { assertPublicHost } from "./ssrfGuard.js";

export interface ResolvedPeer {
  domain: string;
  baseUrl: string;
  apiBase: string; // federation API base, e.g. "/federation/v1"
  publicKey: string;
  // True only when baseUrl came from FEDERATION_PEER_OVERRIDES (operator-set
  // local dev config), never from peer/user-supplied input. Lets callers
  // that make further outbound requests against this peer (client.ts's
  // federationFetch) decide whether they still need their own SSRF check -
  // this one has already passed it, an override deliberately never does.
  trusted: boolean;
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
    return {
      domain,
      baseUrl: cached.baseUrl,
      apiBase: "/federation/v1",
      publicKey: cached.publicKey,
      trusted: Boolean(config.federationPeerOverrides[domain]),
    };
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

  // `domain` is untrusted (peer- or user-supplied) whenever there's no
  // override - a locally-authenticated user can type any `@user:domain`
  // as a friend-request/DM target, and nothing before this point stops
  // them pointing it at an internal address. Overrides are operator-set
  // local dev config (how the alice.test/bob.test demo reaches real
  // localhost ports) and are deliberately exempt.
  if (!overrideBaseUrl) {
    await assertPublicHost(new URL(baseUrl).hostname);
  }

  // redirect: "error" so a domain that passes the check above can't then
  // redirect the actual request somewhere private - validating once and
  // blindly following wherever the response points next would defeat the
  // check above entirely.
  //
  // Note for future readers (and CodeQL): baseUrl's hostname was just
  // validated by assertPublicHost() above (skipped only for
  // FEDERATION_PEER_OVERRIDES, which is operator-set local config, not
  // attacker input). CodeQL's static taint analysis doesn't recognize an
  // opaque async guard function as a sanitizer, so it still flags this
  // fetch as js/request-forgery even with the runtime check in place -
  // the corresponding alert is dismissed as a false positive with this
  // explanation (see dismissal comment on the alert itself).
  const res = await fetch(`${baseUrl}/.well-known/communication-platform`, { redirect: "error" });
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
    trusted: Boolean(overrideBaseUrl),
  };
}
