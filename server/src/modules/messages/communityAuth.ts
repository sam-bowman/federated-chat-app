import { prisma } from "../../db.js";
import { getMemberPermissions } from "../communities/routes.js";

/**
 * What a user may do in the community a channel message belongs to: their combined role
 * permissions there, or null when the message is not in a community channel (a DM or group
 * conversation has no roles, so nothing here applies to it). A non-member gets 0n, so every
 * permission check against the result fails for them.
 *
 * Always derived from the MESSAGE's own channel, never from an id in a URL: someone who holds a
 * permission in one community must not be able to use it on another's messages by mixing ids.
 */
export async function communityPermissionsForMessage(
  message: { channelId: string | null },
  userId: string
): Promise<bigint | null> {
  if (!message.channelId) return null;
  const channel = await prisma.channel.findUnique({
    where: { id: message.channelId },
    select: { communityId: true, community: { select: { ownerId: true } } },
  });
  if (!channel) return null;
  return getMemberPermissions(channel.communityId, userId, channel.community.ownerId);
}

/** True when this message lives in a channel of exactly this community (and, if given, this channel). */
export async function messageIsInCommunity(
  message: { channelId: string | null },
  communityId: string,
  channelProtocolId?: string
): Promise<boolean> {
  if (!message.channelId) return false;
  const channel = await prisma.channel.findUnique({
    where: { id: message.channelId },
    select: { communityId: true, protocolId: true },
  });
  if (!channel || channel.communityId !== communityId) return false;
  return channelProtocolId === undefined || channel.protocolId === channelProtocolId;
}
