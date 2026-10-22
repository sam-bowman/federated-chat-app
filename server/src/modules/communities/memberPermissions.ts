import { prisma } from "../../db.js";
import { ALL_PERMISSIONS, combinePermissions } from "../../lib/permissions.js";

/**
 * What a person may do in a community: the owner holds every bit, anyone else the union of their roles, and someone who is not a member
 * holds nothing. The one place this is worked out, for the routes that check it and for what has to act when it changes (the voice rooms).
 * `userId` is the person's database id, `ownerId` the community's.
 */
export async function getMemberPermissions(communityId: string, userId: string, ownerId: string): Promise<bigint> {
  if (userId === ownerId) return ALL_PERMISSIONS;
  const membership = await prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId } },
    include: { roles: { include: { role: true } } },
  });
  if (!membership) return 0n;
  return combinePermissions(membership.roles.map((r) => r.role.permissions));
}
