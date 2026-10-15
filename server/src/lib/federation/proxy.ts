import { federationFetch } from "./client.js";
import { FederationDisabledError, FederationDomainBlockedError, peerRefusal } from "./errors.js";

const DEFAULT_PROXY_TIMEOUT_MS = 8000;

export class FederationProxyError extends Error {
  constructor(
    public status: number,
    public body: unknown
  ) {
    super(`federation_proxy_failed:${status}`);
  }
}

/**
 * A blocking, result-dependent call to another homeserver - unlike every
 * other federation call site (enqueueFederationEvent's commit-then-best-
 * effort-deliver pattern), the caller's own HTTP response genuinely depends
 * on this succeeding. Used when a remote member's own server proxies a
 * mutating community action (join/leave/send/edit/delete/react) to the
 * community's home server. Pass a short timeoutMs (federationFetch has no
 * default one - fine for the outbox, wrong for a human waiting) so a
 * briefly-unreachable home server fails fast rather than hanging the
 * request indefinitely.
 */
export async function proxyToHomeServer<T>(
  domain: string,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  let res: Response;
  try {
    res = await federationFetch(domain, path, {
      method: options.method,
      body: options.body,
      timeoutMs: options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS,
      // A successful proxy call is just as valid evidence the peer is
      // reachable as any outbox delivery - let it opportunistically flush
      // that domain's queued backlog too, same as every other federationFetch caller.
    });
  } catch (err) {
    // Not unreachable: this server is private, which is a different thing for the person to be told.
    if (err instanceof FederationDisabledError) throw new FederationProxyError(403, { error: "federation_disabled" });
    // Nor unreachable: this server does not talk to that one.
    if (err instanceof FederationDomainBlockedError) throw new FederationProxyError(403, { error: "federation_domain_blocked" });
    throw new FederationProxyError(502, { error: "federation_unreachable" });
  }
  // The OTHER server is private, or refuses this one: from here that is a server that cannot be reached, and saying "this server
  // does not connect to other servers" would put the blame on the wrong one.
  if (await peerRefusal(res)) throw new FederationProxyError(502, { error: "federation_unreachable" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new FederationProxyError(res.status, body);
  return body as T;
}
