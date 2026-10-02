import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { emitSyncEvent } from "../sync/events.js";
import { serializeMessage } from "./serialize.js";
import { getAccessibleEmoticons } from "../emoticons/service.js";

export const messagesRouter = Router();

const include = {
  sender: true,
  attachments: true,
  reactions: { include: { user: true } },
  replyTo: { include: { sender: true } },
} as const;

// Every message event needs to carry WHERE it happened (as a protocol id,
// not the local DB id) so a client with several conversations/channels open
// across components can tell "is this event for the thread I'm looking at"
// instead of blindly applying it - without this, a message created in one
// conversation/channel would get appended into whichever one happens to be
// mounted when the event arrives.
async function messageContext(message: { conversationId: string | null; channelId: string | null }, excludeUserId: string) {
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
    if (!channel) return { recipients: [] as string[], location: {} };
    const members = await prisma.communityMember.findMany({ where: { communityId: channel.communityId } });
    return {
      recipients: members.map((m) => m.userId).filter((id) => id !== excludeUserId),
      location: { channelId: channel.protocolId },
    };
  }
  return { recipients: [] as string[], location: {} };
}

const editSchema = z.object({ content: z.string().min(1).max(8000) });

messagesRouter.patch("/:id", requireAuth, async (req, res) => {
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
  if (message.senderId !== req.userId) return res.status(403).json({ error: "forbidden" });

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { content: parsed.data.content, editedAt: new Date() },
    include,
  });

  const senderEmoticons = await getAccessibleEmoticons(message.senderId);
  const serialized = serializeMessage(updated as any, senderEmoticons);
  const { recipients, location } = await messageContext(message, req.userId!);
  await emitSyncEvent(recipients, "message:edited", { message: serialized, ...location });
  res.json({ message: serialized });
});

messagesRouter.delete("/:id", requireAuth, async (req, res) => {
  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
  if (message.senderId !== req.userId) return res.status(403).json({ error: "forbidden" });

  await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
  const { recipients, location } = await messageContext(message, req.userId!);
  await emitSyncEvent(recipients, "message:deleted", { messageId: message.protocolId, ...location });
  res.status(204).end();
});

const reactSchema = z.object({ emoji: z.string().min(1).max(32) });

messagesRouter.post("/:id/reactions", requireAuth, async (req, res) => {
  const parsed = reactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });

  await prisma.reaction.upsert({
    where: { messageId_userId_emoji: { messageId: message.id, userId: req.userId!, emoji: parsed.data.emoji } },
    create: { messageId: message.id, userId: req.userId!, emoji: parsed.data.emoji },
    update: {},
  });

  const updated = await prisma.message.findUnique({ where: { id: message.id }, include });
  const senderEmoticons1 = await getAccessibleEmoticons(message.senderId);
  const serialized = serializeMessage(updated as any, senderEmoticons1);
  const { recipients: recipients1, location: location1 } = await messageContext(message, req.userId!);
  await emitSyncEvent(recipients1, "message:reaction_added", {
    messageId: message.protocolId,
    reactions: serialized.reactions,
    ...location1,
  });
  res.json({ message: serialized });
});

messagesRouter.delete("/:id/reactions/:emoji", requireAuth, async (req, res) => {
  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message) return res.status(404).json({ error: "not_found" });

  await prisma.reaction.deleteMany({
    where: { messageId: message.id, userId: req.userId!, emoji: req.params.emoji },
  });

  const updated = await prisma.message.findUnique({ where: { id: message.id }, include });
  const senderEmoticons2 = await getAccessibleEmoticons(message.senderId);
  const serialized = serializeMessage(updated as any, senderEmoticons2);
  const { recipients: recipients2, location: location2 } = await messageContext(message, req.userId!);
  await emitSyncEvent(recipients2, "message:reaction_removed", {
    messageId: message.protocolId,
    reactions: serialized.reactions,
    ...location2,
  });
  res.json({ message: serialized });
});
