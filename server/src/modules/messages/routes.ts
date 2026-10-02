import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { emitSyncEvent } from "../sync/events.js";
import { serializeMessage } from "./serialize.js";

export const messagesRouter = Router();

const include = {
  sender: true,
  attachments: true,
  reactions: { include: { user: true } },
  replyTo: { include: { sender: true } },
} as const;

async function recipientsFor(message: { conversationId: string | null; channelId: string | null }, excludeUserId: string) {
  if (message.conversationId) {
    const members = await prisma.conversationMember.findMany({ where: { conversationId: message.conversationId } });
    return members.map((m) => m.userId).filter((id) => id !== excludeUserId);
  }
  if (message.channelId) {
    const channel = await prisma.channel.findUnique({ where: { id: message.channelId } });
    if (!channel) return [];
    const members = await prisma.communityMember.findMany({ where: { communityId: channel.communityId } });
    return members.map((m) => m.userId).filter((id) => id !== excludeUserId);
  }
  return [];
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

  const serialized = serializeMessage(updated as any);
  await emitSyncEvent(await recipientsFor(message, req.userId!), "message:edited", { message: serialized });
  res.json({ message: serialized });
});

messagesRouter.delete("/:id", requireAuth, async (req, res) => {
  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
  if (message.senderId !== req.userId) return res.status(403).json({ error: "forbidden" });

  await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
  await emitSyncEvent(await recipientsFor(message, req.userId!), "message:deleted", { messageId: message.protocolId });
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
  const serialized = serializeMessage(updated as any);
  await emitSyncEvent(await recipientsFor(message, req.userId!), "message:reaction_added", {
    messageId: message.protocolId,
    reactions: serialized.reactions,
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
  const serialized = serializeMessage(updated as any);
  await emitSyncEvent(await recipientsFor(message, req.userId!), "message:reaction_removed", {
    messageId: message.protocolId,
    reactions: serialized.reactions,
  });
  res.json({ message: serialized });
});
