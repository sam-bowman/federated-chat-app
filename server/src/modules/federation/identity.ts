import { config } from "../../config.js";
import { parseIdentity } from "../../lib/ids.js";
import type { User } from "../../generated/prisma/client.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { federationFetch } from "../../lib/federation/client.js";
import { FederationDisabledError, FederationDomainBlockedError } from "../../lib/federation/errors.js";
import { ensureRemoteUser } from "./remoteUsers.js";
import { canContact } from "../users/contact.js";

/**
 * Fetches a user's public profile directly from their own claimed
 * homeserver and caches it as a remote stub - never trusts a third party's
 * say-so about who they are. Shared by resolveOrFetchUser (a bare identity
 * string from local input) and verifyRemoteMember (a member claimed by
 * another peer in a federation payload, which must be independently
 * confirmed by the member's own domain rather than taken at face value -
 * see federation/routes.ts's POST /conversations handler).
 */
async function fetchRemoteUserProfile(domain: string, username: string, from?: string) {
  try {
    // `from` names the person who wants to start something with them, so their server can say whether its owner's setting lets
    // them (the answer is a courtesy, to refuse early and plainly: the other server decides again when it is actually sent).
    const query = from ? `?from=${encodeURIComponent(from)}` : "";
    const res = await federationFetch(domain, `/users/${username}${query}`, { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      user?: { id: string; username: string; displayName: string; avatarUrl: string | null };
      contact?: { allowed?: unknown };
    };
    if (!body.user) return null;
    const user = await ensureRemoteUser({
      protocolId: body.user.id,
      username: body.user.username,
      domain,
      displayName: body.user.displayName,
      avatarUrl: body.user.avatarUrl,
    });
    // A server that predates the setting, or was not asked, says nothing: that is not a refusal.
    return { user, contactAllowed: body.contact?.allowed !== false };
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
  return (await resolveWithContact(input))?.user ?? null;
}

/**
 * The same, and whether `contactBy` (the person who wants to start something with them) is allowed to by the other person's setting
 * (lib/contactPolicy.ts). The caller decides what to do with a "no": a conversation that already exists is not "started", so it may
 * still be opened. Without `contactBy` the answer is always yes.
 */
export async function resolveWithContact(input: string, contactBy?: User): Promise<{ user: User; contactAllowed: boolean } | null> {
  const parsed = parseIdentity(input, config.domain);
  if (!parsed) return null;

  if (parsed.domain === config.domain) {
    const user = await findLocalUserByUsername(parsed.username);
    if (!user) return null;
    return { user, contactAllowed: contactBy ? await canContact(user, contactBy) : true };
  }

  // Someone on another server cannot be looked up from a private one. Said so plainly (the API answers 403
  // federation_disabled) rather than as "no such user", which would be untrue.
  if (!config.federationEnabled) throw new FederationDisabledError();
  // ...and nor from a server this one does not talk to, which is not "no such user" either.
  if (!config.federationPolicy.isPermitted(parsed.domain)) throw new FederationDomainBlockedError(parsed.domain);

  return fetchRemoteUserProfile(parsed.domain, parsed.username, contactBy?.username);
}

/**
 * Independently verifies a member a federation peer claims is on some
 * *other* domain (neither ours nor the calling peer's own) by asking that
 * domain directly - the payload's claimed protocolId/displayName/avatarUrl
 * for a third party is never trusted, only what that party's own
 * homeserver reports about them.
 */
export async function verifyRemoteMember(domain: string, username: string) {
  return (await fetchRemoteUserProfile(domain, username))?.user ?? null;
}
