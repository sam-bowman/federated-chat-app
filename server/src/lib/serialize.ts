import type { FriendRequest, User } from "@prisma/client";
import { identityFor } from "./ids.js";

function absoluteUrl(user: User, url: string | null): string | null {
  if (!url) return null;
  if (!user.isRemote || !user.homeserverBaseUrl) return url;
  // A relative `/uploads/x` only exists on the server that stored it - for a
  // remote stub, that's their homeserver, not ours, so make it absolute.
  if (/^https?:\/\//.test(url)) return url;
  return `${user.homeserverBaseUrl}${url}`;
}

/**
 * Serializes a user for an API response. `viewerId` (the requesting local
 * user's db id) decides whether INVISIBLE is reported truthfully or, like
 * everyone else sees it, as OFFLINE - omitting it (the default) always hides
 * it, which is the safe choice for any call site that isn't specifically
 * "a user looking at their own profile" (GET/PATCH /me and friends). Without
 * this, a friend fetching the friends list on page load (rather than via the
 * live WebSocket presence event, which already masked it) would see your
 * true status, defeating invisible mode entirely.
 */
export function publicUser(user: User, viewerId?: string) {
  const isSelf = viewerId !== undefined && viewerId === user.id;
  const status = user.presenceStatus === "INVISIBLE" && !isSelf ? "OFFLINE" : user.presenceStatus;
  return {
    id: user.protocolId,
    identity: identityFor(user.username, user.homeserverDomain),
    username: user.username,
    displayName: user.displayName,
    avatarUrl: absoluteUrl(user, user.avatarUrl),
    bio: user.bio,
    presence: {
      status,
      customStatus: user.customStatus,
      lastSeenAt: user.lastSeenAt,
    },
  };
}

export type PublicUser = ReturnType<typeof publicUser>;

export type FriendRequestWithUsers = FriendRequest & { fromUser: User; toUser: User };

export function serializeFriendRequest(fr: FriendRequestWithUsers) {
  return {
    id: fr.protocolId,
    from: publicUser(fr.fromUser),
    to: publicUser(fr.toUser),
    message: fr.message,
    status: fr.status,
    createdAt: fr.createdAt,
  };
}
