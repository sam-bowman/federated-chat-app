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

export function publicUser(user: User) {
  return {
    id: user.protocolId,
    identity: identityFor(user.username, user.homeserverDomain),
    username: user.username,
    displayName: user.displayName,
    avatarUrl: absoluteUrl(user, user.avatarUrl),
    bio: user.bio,
    presence: {
      status: user.presenceStatus,
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
