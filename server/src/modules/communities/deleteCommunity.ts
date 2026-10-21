import type { Community } from "@prisma/client";
import { prisma } from "../../db.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { getRemoteCommunityDomains } from "../messages/federationRelay.js";
import { emitSyncEvent } from "../sync/events.js";
import { closeVoiceRooms, voiceChannelIdsOf } from "../voice/service.js";
import { collectCommunityMediaUrls, deleteUnreferencedMedia } from "./communityMedia.js";

/**
 * Deletes a community this server hosts, and everything it takes with it: the schema cascades the channels, messages, reactions,
 * roles, memberships, bans and the community's own emoticons, and what the cascade cannot reach is handled here: every member is
 * told, remote members' servers are pinged to drop their cached copy (they re-fetch, get 404 and drop it, see the /updated handler
 * in federation/routes.ts), the voice rooms are closed, and the uploaded files nothing else uses are removed. One code path for
 * the owner deleting their community (the route) and for an operator deleting it (the admin command).
 */
export async function deleteCommunity(community: Pick<Community, "id" | "protocolId">): Promise<void> {
  // Everything below needs the rows that the delete removes, so gather it first.
  const remoteDomains = await getRemoteCommunityDomains(community.id);
  const localMembers = await prisma.communityMember.findMany({
    where: { communityId: community.id, user: { isRemote: false } },
    select: { userId: true },
  });
  const mediaUrls = await collectCommunityMediaUrls(community.id);
  const voiceRooms = await voiceChannelIdsOf(community.id);

  await prisma.community.delete({ where: { id: community.id } });
  await closeVoiceRooms(voiceRooms);

  await emitSyncEvent(
    localMembers.map((m) => m.userId),
    "community:deleted",
    { communityId: community.protocolId }
  );
  for (const domain of remoteDomains) {
    await enqueueFederationEvent(domain, `/communities/${community.protocolId}/updated`, {});
  }
  await deleteUnreferencedMedia(mediaUrls);
}
