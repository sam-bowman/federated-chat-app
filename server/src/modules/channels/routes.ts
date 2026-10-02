import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { newProtocolId } from "../../lib/ids.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import { emitSyncEvent } from "../sync/events.js";
import { serializeMessage } from "../messages/serialize.js";
import { getMemberPermissions } from "../communities/routes.js";

export const channelsRouter = Router();

const include = {
  sender: true,
  attachments: true,
  reactions: { include: { user: true } },
  replyTo: { include: { sender: true } },
} as const;

async function requireChannelAccess(channelProtocolId: string, userId: string) {
  const channel = await prisma.channel.findUnique({
    where: { protocolId: channelProtocolId },
    include: { community: true },
  });
  if (!channel) return null;
  const membership = await prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId: channel.communityId, userId } },
  });
  if (!membership) return null;
  return channel;
}

channelsRouter.get("/:id/messages", requireAuth, async (req, res) => {
  const channel = await requireChannelAccess(req.params.id, req.userId!);
  if (!channel) return res.status(404).json({ error: "not_found" });

  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const before = req.query.before as string | undefined;
  let beforeDate: Date | undefined;
  if (before) {
    const beforeMsg = await prisma.message.findUnique({ where: { protocolId: before } });
    beforeDate = beforeMsg?.createdAt;
  }

  const messages = await prisma.message.findMany({
    where: { channelId: channel.id, ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    include,
  });

  res.json({ messages: messages.reverse().map((m) => serializeMessage(m as any)) });
});

const attachmentInput = z.object({
  url: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const sendSchema = z.object({
  content: z.string().min(1).max(8000),
  replyToId: z.string().optional(),
  attachments: z.array(attachmentInput).max(10).optional(),
});

channelsRouter.post("/:id/messages", requireAuth, async (req, res) => {
  const channel = await requireChannelAccess(req.params.id, req.userId!);
  if (!channel) return res.status(404).json({ error: "not_found" });

  const perms = await getMemberPermissions(channel.communityId, req.userId!, channel.community.ownerId);
  if (!hasPermission(perms, Permission.SEND_MESSAGES)) return res.status(403).json({ error: "forbidden" });

  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  let replyToId: string | undefined;
  if (parsed.data.replyToId) {
    const replyTo = await prisma.message.findUnique({ where: { protocolId: parsed.data.replyToId } });
    if (replyTo && replyTo.channelId === channel.id) replyToId = replyTo.id;
  }

  const message = await prisma.message.create({
    data: {
      protocolId: newProtocolId(),
      channelId: channel.id,
      senderId: req.userId!,
      content: parsed.data.content,
      replyToId,
      attachments: parsed.data.attachments ? { create: parsed.data.attachments } : undefined,
    },
    include,
  });

  const members = await prisma.communityMember.findMany({ where: { communityId: channel.communityId } });
  const serialized = serializeMessage(message as any);
  await emitSyncEvent(
    members.map((m) => m.userId).filter((id) => id !== req.userId),
    "message:created",
    { message: serialized, channelId: channel.protocolId }
  );
  res.status(201).json({ message: serialized });
});
