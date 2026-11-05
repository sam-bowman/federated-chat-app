import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";
import type { User } from "../../generated/prisma/client.js";
import { getAccessibleEmoticons } from "../emoticons/service.js";
import { getRemoteCommunityDomains } from "../messages/federationRelay.js";
import { serializeMessage } from "../messages/serialize.js";
import { cleanRichEmbeds, fallbackText } from "../../lib/richEmbed.js";
import { emitSyncEvent } from "../sync/events.js";

/** What a channel message is loaded with to be shown or sent on. */
export const channelMessageInclude = {
  sender: true,
  attachments: true,
  reactions: { include: { user: true, emoticon: true } },
  replyTo: { include: { sender: true } },
} as const;

type Delivered = Awaited<ReturnType<typeof prisma.message.create<{ data: never; include: typeof channelMessageInclude }>>>;

/**
 * Tells everyone who should see a message just written to a channel of a community THIS server hosts: its local members (a live event and
 * the sync log), and every other server that has a member in the community (a signed event through the outbox, so a server that is down
 * gets it later). Used by the channel's send route and by an incoming webhook, so the two cannot drift. Returns the message as it is shown.
 *
 * The sender is not told about their own message (they have it from the answer). A webhook's sender is not a member, so nothing is removed.
 */
export async function deliverChannelMessage(
  message: Delivered,
  channel: { protocolId: string; communityId: string; community: { protocolId: string } },
  sender: Pick<User, "id" | "protocolId" | "username" | "displayName" | "isBot">
) {
  const members = await prisma.communityMember.findMany({ where: { communityId: channel.communityId } });
  const senderEmoticons = await getAccessibleEmoticons(sender.id);
  const serialized = serializeMessage(message as any, senderEmoticons);
  await emitSyncEvent(
    members.map((m) => m.userId).filter((id) => id !== sender.id),
    "message:created",
    { message: serialized, channelId: channel.protocolId }
  );

  // Relay to every remote member's homeserver so their cached copy of this channel stays current - mirrors conversations/routes.ts's DM
  // relay, just targeting a community's channel instead of a conversation.
  const remoteDomains = await getRemoteCommunityDomains(channel.communityId);
  if (remoteDomains.length > 0) {
    const absoluteAttachments = message.attachments.map((a) => ({
      url: toAbsoluteMediaUrl(a.url, config.baseUrl),
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    }));
    // A message that is only cards carries a plain-text stand-in, because a server that predates cards requires some text and shows only that;
    // one that knows cards drops the stand-in (it is a pure function of the cards, lib/richEmbed.ts fallbackText), so nobody sees both.
    const richEmbeds = cleanRichEmbeds(message.richEmbeds);
    const wireContent = message.content === "" && richEmbeds.length > 0 ? fallbackText(richEmbeds) : message.content;
    for (const domain of remoteDomains) {
      await enqueueFederationEvent(domain, `/communities/${channel.community.protocolId}/channels/${channel.protocolId}/messages`, {
        messageId: message.protocolId,
        fromProtocolId: sender.protocolId,
        fromUsername: sender.username,
        // The name the sender is shown under, so a webhook or a bot is not `~webhook-…` there; a server that predates it ignores it.
        fromDisplayName: sender.displayName,
        fromDomain: config.domain,
        // So a person on another server sees the Bot badge (#132); a server that predates this ignores it.
        fromIsBot: sender.isBot,
        content: wireContent,
        ...(richEmbeds.length > 0 ? { richEmbeds } : {}),
        createdAt: message.createdAt,
        attachments: absoluteAttachments,
      });
    }
  }
  return serialized;
}
