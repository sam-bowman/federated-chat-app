import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { newProtocolId } from "../../lib/ids.js";
import { publicUser } from "../../lib/serialize.js";
import { emitSyncEvent } from "../sync/events.js";
import { serializeMessage } from "../messages/serialize.js";
import { getAccessibleEmoticons } from "../emoticons/service.js";
import { resolveOrFetchUser } from "../federation/identity.js";
import { federationFetch } from "../../lib/federation/client.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";

async function emoticonMapsFor(senderIds: string[]) {
  const unique = [...new Set(senderIds)];
  const maps = await Promise.all(unique.map((id) => getAccessibleEmoticons(id)));
  return new Map(unique.map((id, i) => [id, maps[i]]));
}

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

  const resolvedMembers = await Promise.all(memberUsernames.map((u) => resolveOrFetchUser(u)));
  if (resolvedMembers.some((m) => m === null)) {
    return res.status(404).json({ error: "one_or_more_users_not_found" });
  }
  const members = resolvedMembers as NonNullable<(typeof resolvedMembers)[number]>[];
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

  const protocolId = newProtocolId();
  const conversation = await prisma.conversation.create({
    data: {
      protocolId,
      type,
      title: type === "GROUP" ? title : undefined,
      members: { create: [...memberIds].map((userId) => ({ userId })) },
    },
  });

  const serialized = await serializeConversation(conversation.id);
  const localOtherIds = [...memberIds].filter((id) => id !== req.userId && !members.find((m) => m.id === id)?.isRemote);
  await emitSyncEvent(localOtherIds, "conversation:created", { conversation: serialized });

  // Tell each remote member's homeserver so they end up with a matching
  // Conversation row (same protocolId) to relay messages against.
  const remoteDomains = [...new Set(members.filter((m) => m.isRemote).map((m) => m.homeserverDomain))];
  if (remoteDomains.length > 0) {
    const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    const memberProfiles = [self, ...members].map((m) => ({
      protocolId: m.protocolId,
      username: m.username,
      domain: m.homeserverDomain,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
    }));
    for (const domain of remoteDomains) {
      try {
        await federationFetch(domain, "/conversations", {
          body: { conversationId: protocolId, type, members: memberProfiles },
        });
      } catch (err) {
        console.error(`[federation] conversation handshake with ${domain} failed:`, err);
      }
    }
  }

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

  const sorted = memberships.slice().sort((a, b) => {
    const aTime = a.conversation.messages[0]?.createdAt ?? a.conversation.createdAt;
    const bTime = b.conversation.messages[0]?.createdAt ?? b.conversation.createdAt;
    return bTime.getTime() - aTime.getTime();
  });

  const emoticonMaps = await emoticonMapsFor(
    sorted.map((m) => m.conversation.messages[0]?.senderId).filter((id): id is string => !!id)
  );

  const conversations = sorted.map((m) => {
    const c = m.conversation;
    const lastMessage = c.messages[0];
    const unread = !!lastMessage && lastMessage.senderId !== req.userId! && (!m.lastReadAt || lastMessage.createdAt > m.lastReadAt);
    return {
      id: c.protocolId,
      type: c.type,
      title: c.title,
      createdAt: c.createdAt,
      members: c.members.map((member) => ({ ...publicUser(member.user), nickname: member.nickname })),
      lastMessage: lastMessage ? serializeMessage(lastMessage as any, emoticonMaps.get(lastMessage.senderId)) : null,
      unread,
    };
  });

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

conversationsRouter.post("/:id/read", requireAuth, async (req, res) => {
  const conversation = await requireMembership(req.params.id, req.userId!);
  if (!conversation) return res.status(404).json({ error: "not_found" });

  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: conversation.id, userId: req.userId! } },
    data: { lastReadAt: new Date() },
  });
  res.status(204).end();
});

// Removes the conversation from MY view only - the other member(s) keep it
// and their message history. If that leaves the conversation with no
// members at all, it's cleaned up entirely (cascades its messages).
conversationsRouter.delete("/:id/members/me", requireAuth, async (req, res) => {
  const conversation = await requireMembership(req.params.id, req.userId!);
  if (!conversation) return res.status(404).json({ error: "not_found" });

  await prisma.conversationMember.deleteMany({ where: { conversationId: conversation.id, userId: req.userId! } });

  const remaining = await prisma.conversationMember.count({ where: { conversationId: conversation.id } });
  if (remaining === 0) {
    await prisma.conversation.delete({ where: { id: conversation.id } });
  }
  res.status(204).end();
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

  const emoticonMaps = await emoticonMapsFor(messages.map((m) => m.senderId));
  res.json({
    messages: messages.reverse().map((m) => serializeMessage(m as any, emoticonMaps.get(m.senderId))),
  });
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

  const members = await prisma.conversationMember.findMany({
    where: { conversationId: conversation.id },
    include: { user: true },
  });
  const senderEmoticons = await getAccessibleEmoticons(req.userId!);
  const serialized = serializeMessage(message as any, senderEmoticons);

  const localOtherIds = members.filter((m) => m.userId !== req.userId && !m.user.isRemote).map((m) => m.userId);
  await emitSyncEvent(localOtherIds, "message:created", { message: serialized, conversationId: conversation.protocolId });

  const remoteDomains = [...new Set(members.filter((m) => m.user.isRemote).map((m) => m.user.homeserverDomain))];
  if (remoteDomains.length > 0) {
    // Attachment URLs are relative paths on THIS server under the disk
    // storage driver - make them absolute before handing them to a peer,
    // since a relative path only resolves against the server that stored
    // it. Already-absolute URLs (the S3 driver - see server/src/lib/storage/)
    // pass through unchanged; naively concatenating config.baseUrl onto an
    // already-absolute URL would produce a broken, double-prefixed one.
    const absoluteAttachments = message.attachments.map((a) => ({
      url: toAbsoluteMediaUrl(a.url, config.baseUrl),
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    }));
    for (const domain of remoteDomains) {
      try {
        await federationFetch(domain, "/messages", {
          body: {
            conversationId: conversation.protocolId,
            messageId: message.protocolId,
            fromProtocolId: message.sender.protocolId,
            fromUsername: message.sender.username,
            fromDomain: config.domain,
            content: message.content,
            createdAt: message.createdAt,
            attachments: absoluteAttachments,
          },
        });
      } catch (err) {
        console.error(`[federation] message relay to ${domain} failed:`, err);
      }
    }
  }

  res.status(201).json({ message: serialized });
});
