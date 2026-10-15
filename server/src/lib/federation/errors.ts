/**
 * Thrown by anything that would talk to another server while this one is private (FEDERATION_ENABLED=false).
 * The API turns it into `403 federation_disabled` (see the error middleware in app.ts), so a route that lets it
 * through needs no code of its own; one that wraps federation in its own try/catch decides for itself.
 */
export class FederationDisabledError extends Error {
  constructor() {
    super("federation_disabled");
    this.name = "FederationDisabledError";
  }
}

/**
 * Thrown by anything that would talk to a server this one does not federate with (FEDERATION_ALLOWED_DOMAINS /
 * FEDERATION_BLOCKED_DOMAINS). The API turns it into `403 federation_domain_blocked`, like FederationDisabledError.
 */
export class FederationDomainBlockedError extends Error {
  constructor(readonly domain: string) {
    super("federation_domain_blocked");
    this.name = "FederationDomainBlockedError";
  }
}

/** What a peer says when it will not federate with this server: it is private, or it has this server's domain blocked. */
export type PeerRefusal = "federation_disabled" | "federation_domain_blocked";

/**
 * Whether a peer's answer says it refuses to federate with us at all: `403 federation_disabled` (it is private) or
 * `403 federation_domain_blocked` (it has our domain blocked, or us off its allow list). Either is a state of the other
 * server, not a verdict on what was sent, so callers treat it like an unreachable peer (retry later, say "couldn't reach") and
 * never like a rejection, which for a queued event would lose it for good. Returns which one, or null for any other answer.
 */
export async function peerRefusal(res: Response): Promise<PeerRefusal | null> {
  if (res.status !== 403) return null;
  const body = (await res.clone().json().catch(() => null)) as { error?: unknown } | null;
  return body?.error === "federation_disabled" || body?.error === "federation_domain_blocked" ? body.error : null;
}
