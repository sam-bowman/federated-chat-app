import { Router, type Request, type Response } from "express";
import { recordUserAudit } from "../audit/service.js";
import type { Message } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { emitSyncEvent } from "../sync/events.js";
import { serializeMessage, messageInclude as include, type SerializedMessage } from "./serialize.js";
import { getAccessibleEmoticons } from "../emoticons/service.js";
import {
  localMessageRecipients as messageContext,
  getRemoteConversationDomains,
  getRemoteCommunityDomains,
} from "./federationRelay.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { FederationProxyError, proxyToHomeServer } from "../../lib/federation/proxy.js";
import { canonicalEmoji, isSingleEmoji } from "../../lib/emoji.js";
import { reactionWire, type ReactionKind } from "../../lib/emoticonReaction.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";
import { addReaction, emoticonRef, removeReaction, tooManyReactions, usableEmoticon } from "./reactions.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import { communityPermissionsForMessage } from "./communityAuth.js";
import { refreshAfterEdit, removeEmbeds } from "../linkPreview/service.js";

export const messagesRouter = Router();

/**
 * If `message` belongs to a channel in a community we don't own, this is
 * the caller's own action on it (edit/delete/react) and must be
 * synchronously proxied to the real home server - it alone can run the
 * real ownership/permission check, not a cached mirror of it. Returns
 * null for a DM message or a locally-owned channel (handle normally).
 */
async function remoteChannelFor(channelId: string | null) {
  if (!channelId) return null;
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { community: true } });
  return channel && channel.community.isRemote ? channel : null;
}

/**
 * Where (if anywhere) a channel message's edit/delete/react needs relaying
 * - null when the channel isn't part of a locally-owned community (no
 * channel at all, or it's a cache of a community we don't own - a remote
 * cache never relays anything itself, only the real home server does) or
 * has no remote members to tell.
 */
async function communityRelayTarget(channelId: string): Promise<{ domains: string[]; pathPrefix: string } | null> {
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { community: true } });
  if (!channel || channel.community.isRemote) return null;
  const domains = await getRemoteCommunityDomains(channel.communityId);
  if (domains.length === 0) return null;
  return { domains, pathPrefix: `/communities/${channel.community.protocolId}/channels/${channel.protocolId}` };
}

const editSchema = z.object({ content: z.string().min(1).max(8000) });

messagesRouter.patch("/:id", requireAuth, async (req, res) => {
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });

  const remoteChannel = await remoteChannelFor(message.channelId);
  if (remoteChannel) {
    const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    try {
      const data = await proxyToHomeServer(
        remoteChannel.community.homeserverDomain,
        `/communities/${remoteChannel.community.protocolId}/channels/${remoteChannel.protocolId}/messages/${message.protocolId}/edit`,
        { body: { username: self.username, content: parsed.data.content } }
      );
      return res.json(data);
    } catch (err) {
      if (err instanceof FederationProxyError) return res.status(err.status).json(err.body);
      return res.status(502).json({ error: "federation_unreachable" });
    }
  }

  if (message.senderId !== req.userId) return res.status(403).json({ error: "forbidden" });
  // The card is what the invite is; editing the text under it would only make the two disagree.
  if (message.invite) return res.status(400).json({ error: "cannot_edit_invite" });

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
  } else if (message.channelId) {
    const target = await communityRelayTarget(message.channelId);
    if (target) {
      for (const domain of target.domains) {
        await enqueueFederationEvent(domain, `${target.pathPrefix}/messages/${message.protocolId}/edit`, {
          content: parsed.data.content,
        });
      }
    }
  }

  res.json({ message: serialized });
  // Its previews match the new text: ones for links that are gone leave at once, and the new links are read.
  void refreshAfterEdit(message.id, message.protocolId, parsed.data.content).catch((err) => console.error("[link preview] could not refresh previews after an edit:", err));
});

// The author takes the link previews off their own message (#197). They go for everyone who sees it, here and on other servers, and
// editing the message does not bring them back. Only for a message this server holds as the original: a copy of one from another
// server is theirs to change.
messagesRouter.delete("/:id/embeds", requireAuth, async (req, res) => {
  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });
  if (message.senderId !== req.userId) return res.status(403).json({ error: "forbidden" });
  if (await remoteChannelFor(message.channelId)) return res.status(409).json({ error: "not_hosted_here" });
  await removeEmbeds(message.id);
  res.status(204).end();
});

messagesRouter.delete("/:id", requireAuth, async (req, res) => {
  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });

  const remoteChannel = await remoteChannelFor(message.channelId);
  if (remoteChannel) {
    const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    try {
      await proxyToHomeServer(
        remoteChannel.community.homeserverDomain,
        `/communities/${remoteChannel.community.protocolId}/channels/${remoteChannel.protocolId}/messages/${message.protocolId}/delete`,
        { body: { username: self.username } }
      );
      return res.status(204).end();
    } catch (err) {
      if (err instanceof FederationProxyError) return res.status(err.status).json(err.body);
      return res.status(502).json({ error: "federation_unreachable" });
    }
  }

  if (message.senderId !== req.userId) {
    // Not your own message: only a community moderator may remove it. A DM has no roles, so there
    // it stays sender-only.
    const perms = await communityPermissionsForMessage(message, req.userId!);
    if (perms === null || !hasPermission(perms, Permission.DELETE_MESSAGES)) {
      return res.status(403).json({ error: "forbidden" });
    }
  }

  await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
  // A moderator removing what someone else wrote is on the record (#59): which message and where, never what it said.
  if (message.senderId !== req.userId && message.channelId) {
    const channel = await prisma.channel.findUnique({ where: { id: message.channelId }, include: { community: true } });
    if (channel) {
      await recordUserAudit(req.userId!, {
        action: "message.delete",
        community: channel.community,
        target: { type: "message", id: message.protocolId },
        details: { channel: channel.name },
      });
    }
  }
  const { recipients, location } = await messageContext(message, req.userId!);
  await emitSyncEvent(recipients, "message:deleted", { messageId: message.protocolId, ...location });

  if (message.conversationId) {
    const remoteDomains = await getRemoteConversationDomains(message.conversationId);
    for (const domain of remoteDomains) {
      await enqueueFederationEvent(domain, `/messages/${message.protocolId}/delete`, {});
    }
  } else if (message.channelId) {
    const target = await communityRelayTarget(message.channelId);
    if (target) {
      for (const domain of target.domains) {
        await enqueueFederationEvent(domain, `${target.pathPrefix}/messages/${message.protocolId}/delete`, {});
      }
    }
  }

  res.status(204).end();
});

// A new reaction is exactly one emoji, or a custom emoticon the person can use (named by its id, never its trigger,
// which means different things to different people: #110). (Removing one is not checked: reactions made before
// this rule can be anything up to 32 characters, and their owners must still be able to take them back.)
const reactSchema = z.union([
  z.object({ emoji: z.string().refine(isSingleEmoji, "not a single emoji").transform(canonicalEmoji) }).strict(),
  z.object({ emoticonId: z.string().min(1).max(64) }).strict(),
]);

/** Tells everyone the message's reactions changed: this server's clients, then the other servers with a copy. */
async function announceReaction(
  message: Message,
  actorId: string,
  event: "message:reaction_added" | "message:reaction_removed",
  kind: ReactionKind,
  serialized: SerializedMessage
) {
  const { recipients, location } = await messageContext(message, actorId);
  await emitSyncEvent(recipients, event, { messageId: message.protocolId, reactions: serialized.reactions, ...location });

  const suffix = event === "message:reaction_added" ? "reactions" : "reactions/remove";
  let targets: { domains: string[]; pathPrefix: string } | null = null;
  if (message.conversationId) {
    const domains = await getRemoteConversationDomains(message.conversationId);
    if (domains.length > 0) targets = { domains, pathPrefix: "" };
  } else if (message.channelId) {
    targets = await communityRelayTarget(message.channelId);
  }
  if (!targets) return;

  const reactor = await prisma.user.findUniqueOrThrow({ where: { id: actorId } });
  for (const domain of targets.domains) {
    await enqueueFederationEvent(domain, `${targets.pathPrefix}/messages/${message.protocolId}/${suffix}`, {
      fromDomain: config.domain,
      fromProtocolId: reactor.protocolId,
      fromUsername: reactor.username,
      ...reactionWire(kind),
    });
  }
}

messagesRouter.post("/:id/reactions", requireAuth, async (req, res) => {
  const parsed = reactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message || message.deletedAt) return res.status(404).json({ error: "not_found" });

  // What is being added. An emoticon must be one this person may use (their own, one they saved, or one of a
  // community they are in), and goes to other servers as a reference they can show without owning it.
  let kind: ReactionKind;
  if ("emoji" in parsed.data) {
    kind = { emoji: parsed.data.emoji };
  } else {
    const emoticon = await usableEmoticon(req.userId!, parsed.data.emoticonId);
    if (!emoticon) return res.status(403).json({ error: "emoticon_not_available" });
    kind = { emoticon: emoticonRef(emoticon) };
  }

  const remoteChannel = await remoteChannelFor(message.channelId);
  if (remoteChannel) {
    const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    try {
      const data = await proxyToHomeServer(
        remoteChannel.community.homeserverDomain,
        `/communities/${remoteChannel.community.protocolId}/channels/${remoteChannel.protocolId}/messages/${message.protocolId}/reactions`,
        { body: { username: self.username, ...reactionWire(kind) } }
      );
      return res.json(data);
    } catch (err) {
      if (err instanceof FederationProxyError) return res.status(err.status).json(err.body);
      return res.status(502).json({ error: "federation_unreachable" });
    }
  }

  // In a community channel, adding a reaction needs the REACT permission - which also means being a
  // member at all, since a non-member holds none. Removing your own reaction never needs it.
  const reactPerms = await communityPermissionsForMessage(message, req.userId!);
  if (reactPerms !== null && !hasPermission(reactPerms, Permission.REACT)) {
    return res.status(403).json({ error: "forbidden" });
  }

  // Joining a reaction that is already on the message is always fine; starting a 21st kind is not.
  if (await tooManyReactions(message.id, kind)) return res.status(409).json({ error: "too_many_reactions" });

  await addReaction(message.id, req.userId!, kind);

  const updated = await prisma.message.findUnique({ where: { id: message.id }, include });
  const serialized = serializeMessage(updated as any, await getAccessibleEmoticons(message.senderId));
  await announceReaction(message, req.userId!, "message:reaction_added", kind, serialized);
  res.json({ message: serialized });
});

/** Takes the caller's own reaction back, for either kind: the part that is the same whichever route asked. */
async function takeReactionBack(req: Request, res: Response, kindOf: (messageId: string) => Promise<ReactionKind>) {
  const message = await prisma.message.findUnique({ where: { protocolId: req.params.id } });
  if (!message) return res.status(404).json({ error: "not_found" });

  const kind = await kindOf(message.id);

  const remoteChannel = await remoteChannelFor(message.channelId);
  if (remoteChannel) {
    const self = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    try {
      const data = await proxyToHomeServer(
        remoteChannel.community.homeserverDomain,
        `/communities/${remoteChannel.community.protocolId}/channels/${remoteChannel.protocolId}/messages/${message.protocolId}/reactions/remove`,
        { body: { username: self.username, ...reactionWire(kind) } }
      );
      return res.json(data);
    } catch (err) {
      if (err instanceof FederationProxyError) return res.status(err.status).json(err.body);
      return res.status(502).json({ error: "federation_unreachable" });
    }
  }

  await removeReaction(message.id, req.userId!, kind);

  const updated = await prisma.message.findUnique({ where: { id: message.id }, include });
  const serialized = serializeMessage(updated as any, await getAccessibleEmoticons(message.senderId));
  await announceReaction(message, req.userId!, "message:reaction_removed", kind, serialized);
  res.json({ message: serialized });
}

messagesRouter.delete("/:id/reactions/:emoji", requireAuth, (req, res) =>
  takeReactionBack(req, res, async () => ({ emoji: req.params.emoji }))
);

// A custom emoticon's reaction, by the emoticon's id. The caller may no longer be able to USE the emoticon (they
// un-saved it, or left its community) and must still be able to take their reaction back, so it is found among
// their own reactions, not among their emoticons; what other servers are told about it is what was stored.
messagesRouter.delete("/:id/emoticon-reactions/:emoticonId", requireAuth, (req, res) =>
  takeReactionBack(req, res, async (messageId) => {
    const row = await prisma.reaction.findFirst({
      where: { messageId, userId: req.userId!, emoticonProtocolId: req.params.emoticonId },
      include: { emoticon: true },
    });
    const name = row?.emoticon?.name ?? row?.emoticonName ?? "emoticon";
    const stored = row?.emoticon?.imageUrl ?? row?.emoticonImageUrl ?? "/";
    return { emoticon: { id: req.params.emoticonId, name, imageUrl: toAbsoluteMediaUrl(stored, config.baseUrl) } };
  })
);
