import type { Community, User } from "@prisma/client";
import { prisma } from "../../db.js";
import { notifyLocalMembersOfUpdate, notifyRemoteMembersOfUpdate } from "./notifyMembers.js";

export type TransferFailure = "new_owner_must_be_local" | "already_owner" | "not_a_member" | "ownership_changed";
export type TransferResult = { ok: true } | { ok: false; error: TransferFailure };

/**
 * Hands a community this server hosts to one of its members, and tells everyone: the one code path for the owner doing it (the route, which asks
 * for their password first) and for an admin doing it from the admin page. WHO MAY is the caller's to decide (the owner, or an admin in sudo
 * mode); what is decided here is whether the new owner can be one: a person on this server (a remote owner could not manage the community, since
 * management by a member of another server is not supported), who is not already the owner, and who is a member. The change is conditional on the
 * owner still being `fromOwnerId`, so two overlapping requests cannot both win. The caller writes the audit entry, since who it was differs.
 */
export async function transferOwnership(
  community: Pick<Community, "id" | "protocolId" | "isRemote">,
  newOwner: Pick<User, "id" | "isRemote">,
  fromOwnerId: string
): Promise<TransferResult> {
  if (newOwner.isRemote) return { ok: false, error: "new_owner_must_be_local" };
  if (newOwner.id === fromOwnerId) return { ok: false, error: "already_owner" };
  const membership = await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: newOwner.id } } });
  if (!membership) return { ok: false, error: "not_a_member" };

  const updated = await prisma.community.updateMany({ where: { id: community.id, ownerId: fromOwnerId }, data: { ownerId: newOwner.id } });
  if (updated.count !== 1) return { ok: false, error: "ownership_changed" };

  await notifyLocalMembersOfUpdate(community.id);
  await notifyRemoteMembersOfUpdate(community);
  return { ok: true };
}
