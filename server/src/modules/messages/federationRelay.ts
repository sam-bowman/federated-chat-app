import { prisma } from "../../db.js";

/**
 * Local recipients (sync-event targets) and the {conversationId}/
 * {channelId} location to attach to a WS event for a given message -
 * shared between locally-triggered message routes (messages/routes.ts)
 * and federation-received ones (federation/routes.ts's message edit/
 * delete/reaction handlers), so both notify local clients identically.
 *
 * `excludeUserId` leaves out whoever just performed the action locally
 * (their own client already has the result via the HTTP response, so a
 * redundant WS event isn't needed) - omit it for a federation-received
 * event, where the actor isn't a local user at all.
 *
 * Does not filter out remote members' cached stub ids from `recipients`
 * (matching this function's pre-existing behavior before it was
 * extracted from messages/routes.ts) - sendToUser()/emitSyncEvent() are
 * harmless no-ops for a user with no live local session, which a remote
 * stub never has.
 */
export async function localMessageRecipients(
  message: { conversationId: string | null; channelId: string | null },
  excludeUserId?: string
): Promise<{ recipients: string[]; location: { conversationId?: string; channelId?: string } }> {
  if (message.conversationId) {
    const [members, conversation] = await Promise.all([
      prisma.conversationMember.findMany({ where: { conversationId: message.conversationId } }),
      prisma.conversation.findUnique({ where: { id: message.conversationId }, select: { protocolId: true } }),
    ]);
    return {
      recipients: members.map((m) => m.userId).filter((id) => id !== excludeUserId),
      location: { conversationId: conversation?.protocolId },
    };
  }
  if (message.channelId) {
    const channel = await prisma.channel.findUnique({ where: { id: message.channelId } });
    if (!channel) return { recipients: [], location: {} };
    const members = await prisma.communityMember.findMany({ where: { communityId: channel.communityId } });
    return {
      recipients: members.map((m) => m.userId).filter((id) => id !== excludeUserId),
      location: { channelId: channel.protocolId },
    };
  }
  return { recipients: [], location: {} };
}

/**
 * The distinct remote homeserver domains among a conversation's members -
 * who (if anyone) a local edit/delete/reaction on one of its messages
 * needs relaying to. Federation covers 1:1 DMs only today, so this is
 * either empty (a local-only conversation) or exactly one domain (the
 * other participant's homeserver) - never more, until group DM
 * federation exists.
 */
export async function getRemoteConversationDomains(conversationId: string): Promise<string[]> {
  const members = await prisma.conversationMember.findMany({
    where: { conversationId },
    include: { user: true },
  });
  return [...new Set(members.filter((m) => m.user.isRemote).map((m) => m.user.homeserverDomain))];
}
