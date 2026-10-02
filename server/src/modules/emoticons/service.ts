import { prisma } from "../../db.js";

export interface ResolvedEmoticon {
  id: string;
  trigger: string;
  imageUrl: string;
  name: string;
  allowSave: boolean;
  creatorId: string;
}

/**
 * The set of emoticons a user can use when composing a message: their own
 * personal emoticons, ones they've saved, and ones belonging to communities
 * they're a member of. Used both for the compose-time picker and (keyed by
 * sender, not viewer) to resolve `:trigger:` text in a message so that ANY
 * recipient can see the image - not just people who already have it saved.
 */
export async function getAccessibleEmoticons(userId: string): Promise<Map<string, ResolvedEmoticon>> {
  const memberships = await prisma.communityMember.findMany({
    where: { userId },
    select: { communityId: true },
  });

  const [created, saved, community] = await Promise.all([
    prisma.emoticon.findMany({ where: { creatorId: userId, communityId: null } }),
    prisma.emoticonSave.findMany({ where: { userId }, include: { emoticon: true } }),
    prisma.emoticon.findMany({ where: { communityId: { in: memberships.map((m) => m.communityId) } } }),
  ]);

  const map = new Map<string, ResolvedEmoticon>();
  const add = (e: { protocolId: string; trigger: string; imageUrl: string; name: string; allowSave: boolean; creatorId: string }) =>
    map.set(e.trigger, {
      id: e.protocolId,
      trigger: e.trigger,
      imageUrl: e.imageUrl,
      name: e.name,
      allowSave: e.allowSave,
      creatorId: e.creatorId,
    });

  for (const e of created) add(e);
  for (const s of saved) add(s.emoticon);
  for (const e of community) add(e);
  return map;
}

const TRIGGER_RE = /:[a-z0-9_]+:/g;

/**
 * Picks out just the emoticons actually referenced in `content` from the
 * sender's accessible set, resolved fresh on every read so edits/deletes to
 * the source emoticon are reflected immediately.
 */
export function resolveMessageEmoticons(content: string | null, accessible: Map<string, ResolvedEmoticon>): ResolvedEmoticon[] {
  if (!content) return [];
  const triggers = new Set(content.match(TRIGGER_RE) ?? []);
  const resolved: ResolvedEmoticon[] = [];
  for (const trigger of triggers) {
    const match = accessible.get(trigger);
    if (match) resolved.push(match);
  }
  return resolved;
}
