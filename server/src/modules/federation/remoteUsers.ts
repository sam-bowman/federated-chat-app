import type { User } from "@prisma/client";
import { prisma } from "../../db.js";
import { resolvePeer } from "../../lib/federation/discovery.js";
import { federationFetch } from "../../lib/federation/client.js";
import { sanitizeRemoteProfile } from "../../lib/profileFields.js";

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

export interface RefreshedProfile {
  user: User;
  /** When the person's account was created on their own server, or null if they did not say. */
  memberSince: Date | null;
  /** False when the home server could not be reached or answered with something we cannot use; `user` is then the cached copy. */
  reachable: boolean;
}

// The peer's answer is waited for while a person is looking at a loading dialog, so it must not take as long as
// a background delivery retry may.
const PROFILE_FETCH_TIMEOUT_MS = 4000;

/**
 * Asks a remote person's home server for their current profile and refreshes the cached stub with what it
 * says (display name, picture, bio, pronouns, accent colour). The answer is only used if it is really about this
 * person (same protocolId and username) and each field is checked first (`sanitizeRemoteProfile`), because a
 * peer is a stranger's server. If the server is down, slow, or sends nonsense, the cached copy is returned as
 * it is: opening a profile never fails because of another server.
 */
export async function refreshRemoteProfile(stub: User): Promise<RefreshedProfile> {
  const cached: RefreshedProfile = { user: stub, memberSince: null, reachable: false };
  try {
    const res = await federationFetch(stub.homeserverDomain, `/users/${encodeURIComponent(stub.username)}`, {
      method: "GET",
      timeoutMs: PROFILE_FETCH_TIMEOUT_MS,
    });
    if (!res.ok) return cached;
    const body = (await res.json()) as { user?: Record<string, unknown>; memberSince?: unknown };
    if (!body.user || body.user.id !== stub.protocolId || body.user.username !== stub.username) return cached;

    const fields = sanitizeRemoteProfile(body.user);
    const updated = await prisma.user.update({
      where: { id: stub.id },
      data: {
        displayName: fields.displayName ?? stub.displayName,
        avatarUrl: fields.avatarUrl,
        bio: fields.bio,
        pronouns: fields.pronouns,
        accentColor: fields.accentColor,
      },
    });
    return { user: updated, memberSince: parseMemberSince(body.memberSince), reachable: true };
  } catch {
    return cached;
  }
}

function parseMemberSince(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 60_000 ? null : date;
}
