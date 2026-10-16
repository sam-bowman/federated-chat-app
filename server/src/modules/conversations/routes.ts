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
import { resolveWithContact } from "../federation/identity.js";
import { acceptsOtherServers, effectiveVisibility, joinsWithoutInvite } from "../../lib/communityVisibility.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";
import { MAX_GROUP_MEMBERS } from "../../lib/conversations.js";
import { inviteFallbackText, parseInvite } from "../../lib/invite.js";
import { CARD_INVITE_EXPIRY_SECONDS } from "../../lib/invites.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import { createInvite } from "../communities/inviteService.js";
import { getMemberPermissions } from "../communities/routes.js";
import { FederationProxyError, proxyToHomeServer } from "../../lib/federation/proxy.js";

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
  // Excludes the creator (added separately below via req.userId!), so this
  // caps at MAX_GROUP_MEMBERS - 1 to keep the total conversation size
  // (including the creator) at MAX_GROUP_MEMBERS - the same total a
  // receiving peer's federation handshake enforces on the full member list
  // it's sent (see federation/routes.ts's incomingConversationSchema).
  memberUsernames: z.array(z.string()).min(1).max(MAX_GROUP_MEMBERS - 1),
  title: z.string().max(100).optional(),
});

conversationsRouter.post("/", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { type, memberUsernames, title } = parsed.data;

  const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
  const resolvedMembers = await Promise.all(memberUsernames.map((u) => resolveWithContact(u, self)));
  if (resolvedMembers.some((m) => m === null)) {
    return res.status(404).json({ error: "one_or_more_users_not_found" });
  }
  const resolved = resolvedMembers as NonNullable<(typeof resolvedMembers)[number]>[];
  const members = resolved.map((r) => r.user);
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

  // Starting a conversation is something each person's setting (lib/contactPolicy.ts) decides, so it is judged here, after an
  // existing direct message has been found: one that already exists is not being started, and stays open.
  if (resolved.some((r) => !r.contactAllowed)) return res.status(403).json({ error: "contact_not_allowed" });

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
      await enqueueFederationEvent(domain, "/conversations", {
        conversationId: protocolId,
        type,
        members: memberProfiles,
        // Who is creating it, so each person added can judge their own setting against the person who is adding them.
        createdBy: self.username,
      });
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

const sendMessageSchema = z
  .object({
    // Required, unless this message is an invitation (the server writes its text).
    content: z.string().min(1).max(8000).optional(),
    replyToId: z.string().optional(),
    attachments: z.array(attachmentInput).max(10).optional(),
    // Invite the other member(s) to a community. Only which community: the card's name and server are
    // filled in here from our own records, never taken from the request.
    invite: z.object({ communityId: z.string().min(1).max(100) }).optional(),
  })
  .refine((v) => (v.invite ? !v.attachments?.length : v.content !== undefined), {
    message: "a message needs text, or is an invite with no attachments",
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

  let invite: ReturnType<typeof parseInvite> = null;
  if (parsed.data.invite) {
    // "<protocolId>" or "<protocolId>:<domain>": the community is found by its id (ours, or one we hold a
    // cached copy of); the domain in a reference is ignored, our own record says where it lives.
    const protocolId = parsed.data.invite.communityId.trim().replace(/^@/, "").split(":")[0];
    const community = await prisma.community.findUnique({ where: { protocolId } });
    if (!community) return res.status(404).json({ error: "community_not_found" });
    // Only a member can invite to a community: anyone else would be vouching for a place they are not in.
    const membership = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: community.id, userId: req.userId! } },
    });
    if (!membership) return res.status(403).json({ error: "not_a_member" });

    // The card carries an invite of its own, so it can expire, be used up or be revoked, and so whoever sent it
    // can be told. One per card: it allows as many joins as the card has recipients (a direct message has one),
    // and lasts a week.
    const recipients = Math.max(1, (await prisma.conversationMember.count({ where: { conversationId: conversation.id } })) - 1);
    // A community that only takes accounts from its own server cannot be joined from a card by anyone on another server (for one hosted
    // elsewhere that includes the sender, whose own server cannot make such an invite either).
    if (!acceptsOtherServers(effectiveVisibility(community.visibility, config.communityVisibilityLimit))) {
      const elsewhere = await prisma.conversationMember.count({
        where: {
          conversationId: conversation.id,
          user: { NOT: { homeserverDomain: { equals: community.homeserverDomain, mode: "insensitive" } } },
        },
      });
      if (elsewhere > 0) return res.status(403).json({ error: "community_local_only" });
    }
    let code: string | undefined;
    if (!community.isRemote) {
      const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
      if (!hasPermission(perms, Permission.CREATE_INVITE)) return res.status(403).json({ error: "forbidden" });
      code = (
        await createInvite({
          communityId: community.id,
          createdById: req.userId!,
          expiresInSeconds: CARD_INVITE_EXPIRY_SECONDS,
          maxUses: recipients,
          viaCard: true,
        })
      ).code;
    } else {
      // The community lives on another server, which alone can make an invite for it.
      const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
      try {
        const made = await proxyToHomeServer<{ invite: { code: string } }>(
          community.homeserverDomain,
          `/communities/${community.protocolId}/invites`,
          { body: { username: self.username, expiresInSeconds: CARD_INVITE_EXPIRY_SECONDS, maxUses: recipients, viaCard: true } }
        );
        code = made.invite.code;
      } catch (err) {
        if (!(err instanceof FederationProxyError)) return res.status(502).json({ error: "federation_unreachable" });
        const reason = (err.body as { error?: string } | null)?.error;
        if (err.status === 403) return res.status(403).json({ error: reason ?? "forbidden" });
        if (err.status === 404 && reason === "not_found") return res.status(404).json({ error: "community_not_found" });
        // Anything else: a server from before invites (it has no such route), or one that cannot be reached right now.
        // A card with no invite still works while the community lets anyone join, so it is sent that way; if the
        // community is closed such a card would be useless, so say so instead.
        if (!joinsWithoutInvite(effectiveVisibility(community.visibility, config.communityVisibilityLimit))) return res.status(502).json({ error: reason ?? "federation_unreachable" });
      }
    }

    invite = parseInvite({
      communityId: community.protocolId,
      domain: community.homeserverDomain.toLowerCase(),
      name: community.name.slice(0, 100),
      code,
    });
    if (!invite) return res.status(422).json({ error: "invite_not_possible" });
  }

  const message = await prisma.message.create({
    data: {
      protocolId: newProtocolId(),
      conversationId: conversation.id,
      senderId: req.userId!,
      content: invite ? inviteFallbackText(invite) : parsed.data.content!,
      invite: invite ?? undefined,
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
      await enqueueFederationEvent(domain, "/messages", {
        conversationId: conversation.protocolId,
        messageId: message.protocolId,
        fromProtocolId: message.sender.protocolId,
        fromUsername: message.sender.username,
        fromDomain: config.domain,
        content: message.content,
        createdAt: message.createdAt,
        attachments: absoluteAttachments,
        invite: parseInvite(message.invite) ?? undefined,
      });
    }
  }

  res.status(201).json({ message: serialized });
});
