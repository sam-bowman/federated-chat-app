import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { emitSyncEvent } from "../sync/events.js";
import { serializeMessage, messageInclude as include } from "./serialize.js";
import { getAccessibleEmoticons } from "../emoticons/service.js";
import { localMessageRecipients as messageContext, getRemoteConversationDomains } from "./federationRelay.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";

export const messagesRouter = Router();

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

  if (message.conversationId) {
    const remoteDomains = await getRemoteConversationDomains(message.conversationId);
    for (const domain of remoteDomains) {
      await enqueueFederationEvent(domain, `/messages/${message.protocolId}/edit`, {
        content: parsed.data.content,
      });
    }
  }

  res.json({ message: serialized });
});

messagesRouter.delete("/:id", requireAuth, async (req, res) => {
  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
  if (message.senderId !== req.userId) return res.status(403).json({ error: "forbidden" });

  await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
  const { recipients, location } = await messageContext(message, req.userId!);
  await emitSyncEvent(recipients, "message:deleted", { messageId: message.protocolId, ...location });

  if (message.conversationId) {
    const remoteDomains = await getRemoteConversationDomains(message.conversationId);
    for (const domain of remoteDomains) {
      await enqueueFederationEvent(domain, `/messages/${message.protocolId}/delete`, {});
    }
  }

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

  if (message.conversationId) {
    const remoteDomains = await getRemoteConversationDomains(message.conversationId);
    if (remoteDomains.length > 0) {
      const reactor = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
      for (const domain of remoteDomains) {
        await enqueueFederationEvent(domain, `/messages/${message.protocolId}/reactions`, {
          fromDomain: config.domain,
          fromProtocolId: reactor.protocolId,
          fromUsername: reactor.username,
          emoji: parsed.data.emoji,
        });
      }
    }
  }

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

  if (message.conversationId) {
    const remoteDomains = await getRemoteConversationDomains(message.conversationId);
    if (remoteDomains.length > 0) {
      const reactor = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
      for (const domain of remoteDomains) {
        await enqueueFederationEvent(domain, `/messages/${message.protocolId}/reactions/remove`, {
          fromDomain: config.domain,
          fromProtocolId: reactor.protocolId,
          fromUsername: reactor.username,
          emoji: req.params.emoji,
        });
      }
    }
  }

  res.json({ message: serialized });
});
