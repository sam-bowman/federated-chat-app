import type { User } from "@prisma/client";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { effectiveDiscoverable } from "../../lib/userDiscoverability.js";

/** An id no user has, so a lookup for someone who does not exist does exactly the work a lookup for a hidden person does. */
const NO_SUCH_USER = "00000000-0000-0000-0000-000000000000";

/**
 * Whether anyone on `domain` has a relationship with this local person: a friendship, a pending friend request either way, a
 * conversation with someone there, or a community shared with someone there (or hosted there). That server already knows the
 * person, so telling it they exist reveals nothing, and what it has with them (friends, messages, a community) must keep working
 * when they hide.
 */
export async function hasRelationshipWithDomain(userId: string, domain: string): Promise<boolean> {
  const there = { homeserverDomain: { equals: domain, mode: "insensitive" as const } };
  const [friend, request, conversation, community] = await Promise.all([
    prisma.friendship.findFirst({ where: { userId, friend: { ...there, isRemote: true } }, select: { id: true } }),
    prisma.friendRequest.findFirst({
      where: {
        status: "PENDING",
        OR: [
          { fromUserId: userId, toUser: { ...there, isRemote: true } },
          { toUserId: userId, fromUser: { ...there, isRemote: true } },
        ],
      },
      select: { id: true },
    }),
    prisma.conversationMember.findFirst({
      where: { userId, conversation: { members: { some: { user: { ...there, isRemote: true } } } } },
      select: { id: true },
    }),
    prisma.communityMember.findFirst({
      where: { userId, community: { OR: [there, { members: { some: { user: { ...there, isRemote: true } } } }] } },
      select: { id: true },
    }),
  ]);
  return Boolean(friend || request || conversation || community);
}

/**
 * Whether the server `domain` may be told this local person exists: they are findable (their own setting, narrowed by the
 * server's), or that server already has a relationship with them. `null` (no such person) is never visible.
 *
 * The caller answers "not found" for both a person who does not exist and one who is hidden, and this is built so that the two
 * cannot be told apart by how long the answer takes either: for both, the relationship queries run, and only a person who is
 * findable skips them (and a findable person is, by definition, not a secret).
 */
export async function isVisibleToDomain(user: User | null, domain: string): Promise<boolean> {
  if (user && effectiveDiscoverable(config.userDiscoverability, user.discoverable)) return true;
  const related = await hasRelationshipWithDomain(user?.id ?? NO_SUCH_USER, domain);
  return user !== null && related;
}
