import { config } from "../../config.js";
import { parseIdentity } from "../../lib/ids.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { federationFetch } from "../../lib/federation/client.js";
import { ensureRemoteUser } from "./remoteUsers.js";

/**
 * Fetches a user's public profile directly from their own claimed
 * homeserver and caches it as a remote stub - never trusts a third party's
 * say-so about who they are. Shared by resolveOrFetchUser (a bare identity
 * string from local input) and verifyRemoteMember (a member claimed by
 * another peer in a federation payload, which must be independently
 * confirmed by the member's own domain rather than taken at face value -
 * see federation/routes.ts's POST /conversations handler).
 */
async function fetchRemoteUserProfile(domain: string, username: string) {
  try {
    const res = await federationFetch(domain, `/users/${username}`, { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      user?: { id: string; username: string; displayName: string; avatarUrl: string | null };
    };
    if (!body.user) return null;
    return await ensureRemoteUser({
      protocolId: body.user.id,
      username: body.user.username,
      domain,
      displayName: body.user.displayName,
      avatarUrl: body.user.avatarUrl,
    });
  } catch {
    return null;
  }
}

/**
 * Resolves an identity string - either a bare `bob` (assumed local) or a
 * full `@bob:bob.test` - to a local User row. For a local domain that's a
 * plain lookup; for a remote one, fetches their public profile from their
 * homeserver and caches it as a remote stub. Returns null if the string
 * doesn't parse, the local user doesn't exist, or the remote fetch fails.
 */
export async function resolveOrFetchUser(input: string) {
  const parsed = parseIdentity(input, config.domain);
  if (!parsed) return null;

  if (parsed.domain === config.domain) {
    return findLocalUserByUsername(parsed.username);
  }

  return fetchRemoteUserProfile(parsed.domain, parsed.username);
}

/**
 * Independently verifies a member a federation peer claims is on some
 * *other* domain (neither ours nor the calling peer's own) by asking that
 * domain directly - the payload's claimed protocolId/displayName/avatarUrl
 * for a third party is never trusted, only what that party's own
 * homeserver reports about them.
 */
export function verifyRemoteMember(domain: string, username: string) {
  return fetchRemoteUserProfile(domain, username);
}
