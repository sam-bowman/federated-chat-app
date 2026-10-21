import { prisma } from "../../db.js";
import { emitSyncEvent } from "../sync/events.js";

/**
 * Tells every local member's client to refetch the community. A change to its roles, channels or settings, AND a change to who
 * is in it (a join, a leave, a kick, a ban, here or from another server), is otherwise only visible to the person who made it
 * until they reload: a member who joined after someone loaded the app was missing from that person's voice channel list (#220).
 * (Remote members' caches are handled separately, via notifyRemoteMembersOfUpdate.)
 */
export async function notifyLocalMembersOfUpdate(communityId: string): Promise<void> {
  const members = await prisma.communityMember.findMany({
    where: { communityId, user: { isRemote: false } },
    select: { userId: true },
  });
  await emitSyncEvent(
    members.map((m) => m.userId),
    "community:updated",
    {}
  );
}
