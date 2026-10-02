import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { newProtocolId } from "../../lib/ids.js";
import { publicUser } from "../../lib/serialize.js";
import { emitSyncEvent } from "../sync/events.js";
import { serializeMessage } from "../messages/serialize.js";

export const conversationsRouter = Router();

async function serializeConversation(conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { members: { include: { user: true } } },
  });
  if (!conversation) return null;
  return {
    id: conversation.protocolId,
    type: conversation.type,
    title: conversation.title,
    createdAt: conversation.createdAt,
    members: conversation.members.map((m) => ({
      ...publicUser(m.user),
      nickname: m.nickname,
    })),
  };
}

const createSchema = z.object({
  type: z.enum(["DM", "GROUP"]),
  memberUsernames: z.array(z.string()).min(1),
  title: z.string().max(100).optional(),
});

conversationsRouter.post("/", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { type, memberUsernames, title } = parsed.data;

  const members = await prisma.user.findMany({ where: { username: { in: memberUsernames } } });
  if (members.length !== new Set(memberUsernames).size) {
    return res.status(404).json({ error: "one_or_more_users_not_found" });
  }
  const memberIds = new Set([req.userId!, ...members.map((m) => m.id)]);

  if (type === "DM") {
    if (memberIds.size !== 2) return res.status(400).json({ error: "dm_requires_exactly_two_members" });
    const otherId = [...memberIds].find((id) => id !== req.userId)!;

    const [blocked, blockedBy] = await Promise.all([
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: req.userId!, blockedId: otherId } } }),
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: otherId, blockedId: req.userId! } } }),
    ]);
    if (blocked || blockedBy) return res.status(403).json({ error: "blocked" });

    const existing = await prisma.conversation.findFirst({
      where: {
        type: "DM",
        members: { every: { userId: { in: [...memberIds] } } },
        AND: [
          { members: { some: { userId: req.userId! } } },
          { members: { some: { userId: otherId } } },
        ],
      },
      include: { members: true },
    });
    const exactMatch = existing && existing.members.length === 2 ? existing : null;
    if (exactMatch) {
      const serialized = await serializeConversation(exactMatch.id);
      return res.status(200).json({ conversation: serialized });
    }
  }

  const conversation = await prisma.conversation.create({
    data: {
      protocolId: newProtocolId(),
      type,
      title: type === "GROUP" ? title : undefined,
      members: { create: [...memberIds].map((userId) => ({ userId })) },
    },
  });

  const serialized = await serializeConversation(conversation.id);
  await emitSyncEvent(
    [...memberIds].filter((id) => id !== req.userId),
    "conversation:created",
    { conversation: serialized }
  );
  res.status(201).json({ conversation: serialized });
});

conversationsRouter.get("/", requireAuth, async (req, res) => {
  const memberships = await prisma.conversationMember.findMany({
    where: { userId: req.userId! },
    include: {
      conversation: {
        include: {
          members: { include: { user: true } },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              sender: true,
              attachments: true,
              reactions: { include: { user: true } },
              replyTo: { include: { sender: true } },
            },
          },
        },
      },
    },
  });

  const conversations = memberships
    .map((m) => m.conversation)
    .sort((a, b) => {
      const aTime = a.messages[0]?.createdAt ?? a.createdAt;
      const bTime = b.messages[0]?.createdAt ?? b.createdAt;
      return bTime.getTime() - aTime.getTime();
    })
    .map((c) => ({
      id: c.protocolId,
      type: c.type,
      title: c.title,
      createdAt: c.createdAt,
      members: c.members.map((m) => ({ ...publicUser(m.user), nickname: m.nickname })),
      lastMessage: c.messages[0] ? serializeMessage(c.messages[0] as any) : null,
    }));

  res.json({ conversations });
});

async function requireMembership(conversationProtocolId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({ where: { protocolId: conversationProtocolId } });
  if (!conversation) return null;
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: conversation.id, userId } },
  });
  if (!membership) return null;
  return conversation;
}

conversationsRouter.get("/:id", requireAuth, async (req, res) => {
  const conversation = await requireMembership(req.params.id, req.userId!);
  if (!conversation) return res.status(404).json({ error: "not_found" });
  res.json({ conversation: await serializeConversation(conversation.id) });
});

conversationsRouter.get("/:id/messages", requireAuth, async (req, res) => {
  const conversation = await requireMembership(req.params.id, req.userId!);
  if (!conversation) return res.status(404).json({ error: "not_found" });

  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const before = req.query.before as string | undefined;
  let beforeDate: Date | undefined;
  if (before) {
    const beforeMsg = await prisma.message.findUnique({ where: { protocolId: before } });
    beforeDate = beforeMsg?.createdAt;
  }

  const messages = await prisma.message.findMany({
    where: {
      conversationId: conversation.id,
      ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { sender: true, attachments: true, reactions: { include: { user: true } }, replyTo: { include: { sender: true } } },
  });

  res.json({ messages: messages.reverse().map((m) => serializeMessage(m as any)) });
});

const attachmentInput = z.object({
  url: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(8000),
  replyToId: z.string().optional(),
  attachments: z.array(attachmentInput).max(10).optional(),
});

conversationsRouter.post("/:id/messages", requireAuth, async (req, res) => {
  const conversation = await requireMembership(req.params.id, req.userId!);
  if (!conversation) return res.status(404).json({ error: "not_found" });

  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  let replyToId: string | undefined;
  if (parsed.data.replyToId) {
    const replyTo = await prisma.message.findUnique({ where: { protocolId: parsed.data.replyToId } });
    if (replyTo && replyTo.conversationId === conversation.id) replyToId = replyTo.id;
  }

  const message = await prisma.message.create({
    data: {
      protocolId: newProtocolId(),
      conversationId: conversation.id,
      senderId: req.userId!,
      content: parsed.data.content,
      replyToId,
      attachments: parsed.data.attachments ? { create: parsed.data.attachments } : undefined,
    },
    include: { sender: true, attachments: true, reactions: { include: { user: true } }, replyTo: { include: { sender: true } } },
  });

  const members = await prisma.conversationMember.findMany({ where: { conversationId: conversation.id } });
  const serialized = serializeMessage(message as any);
  await emitSyncEvent(
    members.map((m) => m.userId).filter((id) => id !== req.userId),
    "message:created",
    { message: serialized }
  );
  res.status(201).json({ message: serialized });
});
