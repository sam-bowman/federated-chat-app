import { config } from "../../config.js";
import { getServerKeyPair } from "./keys.js";
import { resolvePeer } from "./discovery.js";
import { signRequest } from "./signing.js";
import { assertPublicHost } from "./ssrfGuard.js";

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Set by outbox.ts at module load, not imported here directly - this file
// has no business knowing the outbox exists, and importing it directly
// would make client.ts -> outbox.ts -> client.ts a circular import (the
// outbox needs federationFetch itself to actually deliver anything).
// Dependency inversion instead: outbox.ts registers itself as the
// listener, client.ts just calls whatever's registered, if anything.
let onDeliverySuccess: ((domain: string) => void) | undefined;

export function setOnDeliverySuccess(fn: (domain: string) => void): void {
  onDeliverySuccess = fn;
}

/**
 * Signed server-to-server call to a peer's federation inbox. Retries a
 * handful of times on network/5xx failure within this one call; beyond
 * that, a successful call durably flushes anything still queued for this
 * domain (server/src/lib/federation/outbox.ts) - a peer that's down when
 * this fires gets picked back up next time anything succeeds against it,
 * or by the outbox's own background worker, not just dropped.
 */
export async function federationFetch(
  domain: string,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; skipOutboxFlush?: boolean; timeoutMs?: number } = {}
): Promise<Response> {
  const method = options.method ?? "POST";
  const peer = await resolvePeer(domain);
  const { privateKey } = await getServerKeyPair();
  const bodyString = method === "GET" ? "" : JSON.stringify(options.body ?? {});
  const fullPath = `${peer.apiBase}${path}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { timestamp, signature } = signRequest(privateKey, method, fullPath, bodyString);
    try {
      // Re-check right before each real network call, not just once when the
      // peer was resolved - the peer cache has a 10-minute TTL, during which
      // DNS could be rebound to a private address after passing the initial
      // check in discovery.ts. This narrows that window to the gap between
      // two DNS lookups instead of the whole cache lifetime. Skipped for
      // trusted (FEDERATION_PEER_OVERRIDES-resolved) peers, same as discovery.ts.
      if (!peer.trusted) {
        await assertPublicHost(new URL(peer.baseUrl).hostname);
      }
      const res = await fetch(`${peer.baseUrl}${fullPath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Federation-Origin": config.domain,
          "X-Federation-Timestamp": timestamp,
          "X-Federation-Signature": signature,
        },
        body: method === "GET" ? undefined : bodyString,
        redirect: "error",
        // Only the outbox's fire-and-forget retries can tolerate an
        // unbounded wait (nothing is blocked on them) - omitting
        // timeoutMs here keeps that existing behavior unchanged. A
        // synchronous caller (server/src/lib/federation/proxy.ts) that's
        // blocking a real client's HTTP response must pass one.
        signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
      });
      if (res.ok || res.status < 500) {
        if (res.ok && !options.skipOutboxFlush) onDeliverySuccess?.(domain);
        return res; // don't retry client errors (4xx)
      }
      lastError = new Error(`federation_fetch_failed:${domain}:${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_MS * attempt);
  }
  throw lastError;
}
