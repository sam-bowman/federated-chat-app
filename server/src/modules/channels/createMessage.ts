import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { newProtocolId } from "../../lib/ids.js";
import type { StoredInteraction } from "../../lib/interactionRef.js";
import type { PreparedRichEmbeds } from "../../lib/richEmbed.js";
import { scheduleEmbeds } from "../linkPreview/service.js";
import { schedulePictures } from "../richEmbeds/service.js";
import { channelMessageInclude, deliverChannelMessage } from "./deliver.js";

// The one place a message is written to a channel of a community THIS server hosts and told to everyone: the channel's send route, and a bot
// answering a slash command (#132, phase 3b), so the two cannot drift. What it does NOT do is decide whether the sender may: each caller checks
// its own permission first (SEND_MESSAGES for a person or a bot sending, for a bot's visible reply the same).

export interface CreateChannelMessage {
  channel: { id: string; protocolId: string; communityId: string; community: { protocolId: string } };
  senderId: string;
  content: string;
  /** A bot's cards, already prepared (lib/richEmbed.ts prepareRichEmbeds). */
  prepared?: Extract<PreparedRichEmbeds, { ok: true }> | null;
  replyToId?: string;
  attachments?: Prisma.AttachmentCreateWithoutMessageInput[];
  /** Set when the message answers a slash command: who ran which. */
  interaction?: StoredInteraction;
}

/**
 * Writes the message, tells its channel's members live and the other servers that have a member, and gives back the message as it is shown and
 * `afterAnswer`, which the caller runs once its own answer has been sent: the pages the text links to are read, and the pictures a bot named for
 * its cards are copied, after the answer so nobody waits for them.
 */
export async function createChannelMessage(input: CreateChannelMessage) {
  const prepared = input.prepared ?? null;
  const message = await prisma.message.create({
    data: {
      protocolId: newProtocolId(),
      channelId: input.channel.id,
      senderId: input.senderId,
      content: input.content,
      richEmbeds: prepared ? (prepared.embeds as unknown as Prisma.InputJsonValue) : undefined,
      interaction: input.interaction ? (input.interaction as unknown as Prisma.InputJsonValue) : undefined,
      replyToId: input.replyToId,
      attachments: input.attachments ? { create: input.attachments } : undefined,
    },
    include: channelMessageInclude,
  });
  // Everyone who should see it: this server's members live, and the other servers that have a member (modules/channels/deliver.ts).
  const serialized = await deliverChannelMessage(message, input.channel, message.sender);
  const afterAnswer = () => {
    scheduleEmbeds(message.protocolId, message.content);
    if (prepared) schedulePictures(message.id, input.senderId, prepared.embeds, prepared.sources);
  };
  return { message, serialized, afterAnswer };
}
