import { config } from "../../config.js";
import { parseIdentity } from "../../lib/ids.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { federationFetch } from "../../lib/federation/client.js";
import { ensureRemoteUser } from "./remoteUsers.js";

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

  try {
    const res = await federationFetch(parsed.domain, `/users/${parsed.username}`, { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      user?: { id: string; username: string; displayName: string; avatarUrl: string | null };
    };
    if (!body.user) return null;
    return await ensureRemoteUser({
      protocolId: body.user.id,
      username: body.user.username,
      domain: parsed.domain,
      displayName: body.user.displayName,
      avatarUrl: body.user.avatarUrl,
    });
  } catch {
    return null;
  }
}
