import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { newProtocolId } from "../../lib/ids.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import { emitSyncEvent } from "../sync/events.js";
import { serializeMessage } from "../messages/serialize.js";
import { getMemberPermissions } from "../communities/routes.js";
import { getAccessibleEmoticons } from "../emoticons/service.js";
import { getRemoteCommunityDomains } from "../messages/federationRelay.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";
import { FederationProxyError, proxyToHomeServer } from "../../lib/federation/proxy.js";

async function emoticonMapsFor(senderIds: string[]) {
  const unique = [...new Set(senderIds)];
  const maps = await Promise.all(unique.map((id) => getAccessibleEmoticons(id)));
  return new Map(unique.map((id, i) => [id, maps[i]]));
}

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

channelsRouter.post("/:id/read", requireAuth, async (req, res) => {
  const channel = await requireChannelAccess(req.params.id, req.userId!);
  if (!channel) return res.status(404).json({ error: "not_found" });

  await prisma.channelRead.upsert({
    where: { channelId_userId: { channelId: channel.id, userId: req.userId! } },
    create: { channelId: channel.id, userId: req.userId! },
    update: { lastReadAt: new Date() },
  });
  res.status(204).end();
});

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

const sendSchema = z.object({
  content: z.string().min(1).max(8000),
  replyToId: z.string().optional(),
  attachments: z.array(attachmentInput).max(10).optional(),
});

channelsRouter.post("/:id/messages", requireAuth, async (req, res) => {
  const channel = await requireChannelAccess(req.params.id, req.userId!);
  if (!channel) return res.status(404).json({ error: "not_found" });

  // A remote member sending into a community we don't own needs a
  // synchronous proxy to the real home server - it alone can authorize
  // this (run the real SEND_MESSAGES check against the caller's actual
  // role, not a cached mirror of it). No local write happens here at all:
  // the home server's response is passed straight through for this
  // client's own immediate UI update, and the message reaches our local
  // cache a moment later via the ordinary relay (which includes the
  // caller's own domain in its fan-out for exactly this reason - see
  // federation/routes.ts). That relay is idempotent and the client
  // dedupes by message id, so there's no race to worry about even if it
  // arrives before this response does.
  if (channel.community.isRemote) {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
    const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    try {
      const data = await proxyToHomeServer(
        channel.community.homeserverDomain,
        `/communities/${channel.community.protocolId}/channels/${channel.protocolId}/messages`,
        { body: { username: self.username, ...parsed.data } }
      );
      return res.status(201).json(data);
    } catch (err) {
      if (err instanceof FederationProxyError) return res.status(err.status).json(err.body);
      return res.status(502).json({ error: "federation_unreachable" });
    }
  }

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
  const senderEmoticons = await getAccessibleEmoticons(req.userId!);
  const serialized = serializeMessage(message as any, senderEmoticons);
  await emitSyncEvent(
    members.map((m) => m.userId).filter((id) => id !== req.userId),
    "message:created",
    { message: serialized, channelId: channel.protocolId }
  );

  // Relay to every remote member's homeserver so their cached copy of this
  // channel stays current - mirrors conversations/routes.ts's DM relay,
  // just targeting a community's channel instead of a conversation.
  const remoteDomains = await getRemoteCommunityDomains(channel.communityId);
  if (remoteDomains.length > 0) {
    const sender = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    const absoluteAttachments = message.attachments.map((a) => ({
      url: toAbsoluteMediaUrl(a.url, config.baseUrl),
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    }));
    for (const domain of remoteDomains) {
      await enqueueFederationEvent(domain, `/communities/${channel.community.protocolId}/channels/${channel.protocolId}/messages`, {
        messageId: message.protocolId,
        fromProtocolId: sender.protocolId,
        fromUsername: sender.username,
        fromDomain: config.domain,
        content: message.content,
        createdAt: message.createdAt,
        attachments: absoluteAttachments,
      });
    }
  }

  res.status(201).json({ message: serialized });
});
