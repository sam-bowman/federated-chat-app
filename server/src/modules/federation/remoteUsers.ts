import { prisma } from "../../db.js";
import { resolvePeer } from "../../lib/federation/discovery.js";

export interface RemoteProfile {
  // The person's REAL protocolId from their own homeserver - never generate
  // a fresh one here. Every federation payload that introduces a remote
  // person (friend request, conversation member, message sender) must carry
  // it, otherwise the same person ends up with a different cached id on
  // every peer that's seen them, breaking identity matching (the client
  // matches a "presence" event's userId against PublicUser.id, which IS the
  // protocolId - a locally-invented one would never match).
  protocolId: string;
  username: string;
  domain: string;
  displayName: string;
  avatarUrl?: string | null;
}

/**
 * Upserts a cached local stand-in for a remote person so the rest of the
 * schema (FriendRequest, Friendship, ConversationMember, Message.sender)
 * can reference them through the same `User.id` foreign key it already
 * uses for local accounts - no separate "remote user" table, no dual
 * foreign keys anywhere else in the app.
 */
export async function ensureRemoteUser(profile: RemoteProfile) {
  const peer = await resolvePeer(profile.domain);
  return prisma.user.upsert({
    where: { username_homeserverDomain: { username: profile.username, homeserverDomain: profile.domain } },
    create: {
      protocolId: profile.protocolId,
      username: profile.username,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl ?? null,
      homeserverDomain: profile.domain,
      homeserverBaseUrl: peer.baseUrl,
      isRemote: true,
      passwordHash: null,
    },
    update: {
      // Opportunistic cache refresh - every federation payload that
      // mentions this person carries their current profile, so each one is
      // a free chance to keep the cached copy from going stale.
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl ?? null,
      homeserverBaseUrl: peer.baseUrl,
    },
  });
}
