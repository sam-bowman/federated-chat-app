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
 * Whether a peer's answer says IT is private (FEDERATION_ENABLED=false on its side): `403 federation_disabled`. That is a
 * temporary state of the other server, not a verdict on what was sent, so callers treat it like an unreachable peer
 * (retry later, say "couldn't reach") and never like a rejection, which for a queued event would lose it for good.
 */
export async function isPeerFederationDisabled(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = (await res.clone().json().catch(() => null)) as { error?: unknown } | null;
  return body?.error === "federation_disabled";
}
