import type { Emoticon } from "@prisma/client";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { MAX_DISTINCT_REACTIONS, canonicalEmoji } from "../../lib/emoji.js";
import { reactionKey, type EmoticonRef, type ReactionKind } from "../../lib/emoticonReaction.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";

// Adding, removing and counting reactions in one place, so the local routes and the four federated handlers
// (a conversation, and a community's home and cached side, each for add and remove) cannot drift apart.

/** The emoticon, if this person may use it: one they made, one they saved, or one of a community they are in. */
export async function usableEmoticon(userId: string, protocolId: string): Promise<Emoticon | null> {
  const memberships = await prisma.communityMember.findMany({ where: { userId }, select: { communityId: true } });
  return prisma.emoticon.findFirst({
    where: {
      protocolId,
      OR: [
        { creatorId: userId, communityId: null },
        { saves: { some: { userId } } },
        { communityId: { in: memberships.map((m) => m.communityId) } },
      ],
    },
  });
}

/** What another server needs to show this emoticon: the picture as an absolute URL. */
export function emoticonRef(emoticon: Pick<Emoticon, "protocolId" | "name" | "imageUrl">): EmoticonRef {
  return { id: emoticon.protocolId, name: emoticon.name, imageUrl: toAbsoluteMediaUrl(emoticon.imageUrl, config.baseUrl) };
}

export async function addReaction(messageId: string, userId: string, kind: ReactionKind): Promise<void> {
  if ("emoji" in kind) {
    await prisma.reaction.upsert({
      where: { messageId_userId_emoji: { messageId, userId, emoji: kind.emoji } },
      create: { messageId, userId, emoji: kind.emoji },
      update: {},
    });
    return;
  }
  const { id, name, imageUrl } = kind.emoticon;
  // One of this server's own emoticons is linked, so it follows edits and goes when the emoticon is deleted.
  const own = await prisma.emoticon.findUnique({ where: { protocolId: id }, select: { id: true } });
  await prisma.reaction.upsert({
    where: { messageId_userId_emoticonProtocolId: { messageId, userId, emoticonProtocolId: id } },
    create: { messageId, userId, emoticonProtocolId: id, emoticonId: own?.id ?? null, emoticonName: name, emoticonImageUrl: imageUrl },
    update: {},
  });
}

export async function removeReaction(messageId: string, userId: string, kind: ReactionKind): Promise<void> {
  if ("emoji" in kind) {
    // Either spelling (see canonicalEmoji) removes it, so a reaction stored before spellings were unified can be taken back.
    await prisma.reaction.deleteMany({ where: { messageId, userId, emoji: { in: [kind.emoji, canonicalEmoji(kind.emoji)] } } });
    return;
  }
  await prisma.reaction.deleteMany({ where: { messageId, userId, emoticonProtocolId: kind.emoticon.id } });
}

/** Starting a new kind of reaction on a message that already has the most allowed. Joining one that is there is always fine. */
export async function tooManyReactions(messageId: string, kind: ReactionKind): Promise<boolean> {
  const rows = await prisma.reaction.findMany({
    where: { messageId },
    select: { emoji: true, emoticonProtocolId: true },
    distinct: ["emoji", "emoticonProtocolId"],
  });
  const kinds = new Set(
    rows.map((r) => (r.emoticonProtocolId ? reactionKey({ emoticon: { id: r.emoticonProtocolId, name: "", imageUrl: "" } }) : reactionKey({ emoji: r.emoji ?? "" })))
  );
  return kinds.size >= MAX_DISTINCT_REACTIONS && !kinds.has(reactionKey(kind));
}
