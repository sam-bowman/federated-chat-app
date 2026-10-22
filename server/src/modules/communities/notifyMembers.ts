import { prisma } from "../../db.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { getRemoteCommunityDomains } from "../messages/federationRelay.js";
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

/**
 * Pings a remote domain (or every remote domain with a member here, if
 * `targetDomain` is omitted) to re-sync their cached copy of this
 * (locally-owned) community - deliberately one unified "something changed,
 * re-fetch" signal rather than a granular event per change-type (channel
 * created vs renamed, role changed, member kicked/banned, ...), to avoid a
 * combinatorial explosion of relay event types. Self-healing under
 * reordering: a resync always re-fetches current state regardless of which
 * ping triggered it, so two in-flight pings (or one arriving "late") can
 * never leave a receiver worse off than the single most recent one would
 * have. `targetDomain` is used for a kick/ban affecting one specific
 * remote member - the snapshot itself carries no member-list data, so the
 * only thing pinging *other* members would accomplish is a wasted round
 * trip; what matters is that the affected domain's own resync hits the
 * snapshot endpoint's membership gate and discovers it's no longer
 * welcome. No-ops for a remote community (we're never the one who'd notify
 * anyone about our own cache of someone else's community).
 */
export async function notifyRemoteMembersOfUpdate(
  community: { id: string; protocolId: string; isRemote: boolean },
  targetDomain?: string
) {
  if (community.isRemote) return;
  const domains = targetDomain ? [targetDomain] : await getRemoteCommunityDomains(community.id);
  for (const domain of domains) {
    await enqueueFederationEvent(domain, `/communities/${community.protocolId}/updated`, {});
  }
}
