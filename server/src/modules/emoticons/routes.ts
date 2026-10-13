import { Router } from "express";
import { z } from "zod";
import type { Emoticon, User } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { newProtocolId } from "../../lib/ids.js";
import { publicUser } from "../../lib/serialize.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import { getMemberPermissions } from "../communities/routes.js";

export const emoticonsRouter = Router();

/**
 * Who may edit or delete an emoticon: its creator, and - for a community's emoticon - a member of that
 * community holding MANAGE_EMOTICONS (the owner holds everything). Only for a community this server is
 * the home of: a cached copy of someone else's community is not ours to administer.
 */
async function canManageEmoticon(emoticon: { creatorId: string; communityId: string | null }, userId: string) {
  if (emoticon.creatorId === userId) return true;
  if (!emoticon.communityId) return false;
  const community = await prisma.community.findUnique({
    where: { id: emoticon.communityId },
    select: { ownerId: true, isRemote: true },
  });
  if (!community || community.isRemote) return false;
  const perms = await getMemberPermissions(emoticon.communityId, userId, community.ownerId);
  return hasPermission(perms, Permission.MANAGE_EMOTICONS);
}

// `parent` is only present in the output when the caller loaded it (the
// personal-emoticons list and fork/sync responses do - it's what drives the
// "forked from X" line next to Sync fork); omitted otherwise rather than
// claiming `null` for an emoticon that merely wasn't loaded with its parent.
function serialize(
  e: Emoticon & { creator: User; parent?: (Emoticon & { creator: User }) | null },
  triggerOverride?: string | null
) {
  return {
    id: e.protocolId,
    name: e.name,
    trigger: triggerOverride ?? e.trigger,
    imageUrl: e.imageUrl,
    creator: publicUser(e.creator),
    communityId: e.communityId,
    allowSave: e.allowSave,
    allowExport: e.allowExport,
    allowFork: e.allowFork,
    parentId: e.parentId,
    parent:
      e.parent === undefined
        ? undefined
        : e.parent && {
            id: e.parent.protocolId,
            name: e.parent.name,
            trigger: e.parent.trigger,
            creator: publicUser(e.parent.creator),
          },
    createdAt: e.createdAt,
  };
}

// Whether `trigger` already resolves to something else in this user's own
// accessible set (their personal creations, or another saved emoticon) -
// excludes `excludeEmoticonId` (when given) so re-saving the same emoticon
// under its current trigger isn't flagged as a conflict with itself. Forking
// passes nothing: a fork is a brand-new row, so a clash with the user's own
// save of the original is a real clash.
async function isTriggerTaken(userId: string, trigger: string, excludeEmoticonId?: string): Promise<boolean> {
  const personalConflict = await prisma.emoticon.findFirst({
    where: { creatorId: userId, communityId: null, trigger, id: { not: excludeEmoticonId } },
    select: { id: true },
  });
  if (personalConflict) return true;

  const saves = await prisma.emoticonSave.findMany({
    where: { userId, emoticonId: { not: excludeEmoticonId } },
    include: { emoticon: { select: { trigger: true } } },
  });
  return saves.some((s) => (s.trigger ?? s.emoticon.trigger) === trigger);
}

const createSchema = z.object({
  name: z.string().min(1).max(40),
  trigger: z
    .string()
    .min(2)
    .max(40)
    .regex(/^:[a-z0-9_]+:$/, "trigger must look like :name:"),
  imageUrl: z.string().min(1),
  communityId: z.string().optional(),
  allowSave: z.boolean().optional(),
  allowExport: z.boolean().optional(),
  allowFork: z.boolean().optional(),
});

emoticonsRouter.post("/", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  let communityDbId: string | undefined;
  if (parsed.data.communityId) {
    const community = await prisma.community.findUnique({ where: { protocolId: parsed.data.communityId } });
    if (!community) return res.status(404).json({ error: "community_not_found" });
    const membership = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: community.id, userId: req.userId! } },
    });
    if (!membership) return res.status(403).json({ error: "not_a_member" });
    communityDbId = community.id;
  }

  const existingTrigger = await prisma.emoticon.findFirst({
    where: communityDbId
      ? { communityId: communityDbId, trigger: parsed.data.trigger }
      : { creatorId: req.userId!, communityId: null, trigger: parsed.data.trigger },
  });
  if (existingTrigger) return res.status(409).json({ error: "trigger_already_in_use" });

  const emoticon = await prisma.emoticon.create({
    data: {
      protocolId: newProtocolId(),
      creatorId: req.userId!,
      communityId: communityDbId,
      name: parsed.data.name,
      trigger: parsed.data.trigger,
      imageUrl: parsed.data.imageUrl,
      allowSave: parsed.data.allowSave ?? true,
      allowExport: parsed.data.allowExport ?? true,
      allowFork: parsed.data.allowFork ?? true,
    },
    include: { creator: true },
  });
  res.status(201).json({ emoticon: serialize(emoticon) });
});

// Personal emoticons I created, personal emoticons I've saved, and emoticons
// belonging to communities I'm a member of.
emoticonsRouter.get("/", requireAuth, async (req, res) => {
  const memberships = await prisma.communityMember.findMany({
    where: { userId: req.userId! },
    select: { communityId: true },
  });

  const [created, saved, community] = await Promise.all([
    prisma.emoticon.findMany({
      where: { creatorId: req.userId!, communityId: null },
      include: { creator: true, parent: { include: { creator: true } } },
    }),
    prisma.emoticonSave.findMany({
      where: { userId: req.userId! },
      include: { emoticon: { include: { creator: true } } },
    }),
    prisma.emoticon.findMany({
      where: { communityId: { in: memberships.map((m) => m.communityId) } },
      include: { creator: true },
    }),
  ]);

  res.json({
    personal: created.map((e) => serialize(e)),
    saved: saved.map((s) => serialize(s.emoticon, s.trigger)),
    community: community.map((e) => serialize(e)),
  });
});

const saveSchema = z.object({
  trigger: z
    .string()
    .min(2)
    .max(40)
    .regex(/^:[a-z0-9_]+:$/, "trigger must look like :name:")
    .optional(),
});

emoticonsRouter.post("/:id/save", requireAuth, async (req, res) => {
  const emoticon = await prisma.emoticon.findUnique({ where: { protocolId: req.params.id } });
  if (!emoticon) return res.status(404).json({ error: "not_found" });
  if (!emoticon.allowSave) return res.status(403).json({ error: "saving_not_allowed" });

  const parsed = saveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const effectiveTrigger = parsed.data.trigger ?? emoticon.trigger;
  if (await isTriggerTaken(req.userId!, effectiveTrigger, emoticon.id)) {
    return res.status(409).json({ error: "trigger_already_in_use" });
  }
  // Only store an override row when it actually differs from the creator's
  // trigger - null means "just use the original".
  const storedTrigger = effectiveTrigger === emoticon.trigger ? null : effectiveTrigger;

  await prisma.emoticonSave.upsert({
    where: { userId_emoticonId: { userId: req.userId!, emoticonId: emoticon.id } },
    create: { userId: req.userId!, emoticonId: emoticon.id, trigger: storedTrigger },
    update: { trigger: storedTrigger },
  });
  res.status(204).end();
});

emoticonsRouter.delete("/:id/save", requireAuth, async (req, res) => {
  const emoticon = await prisma.emoticon.findUnique({ where: { protocolId: req.params.id } });
  if (!emoticon) return res.status(404).json({ error: "not_found" });

  await prisma.emoticonSave.deleteMany({ where: { userId: req.userId!, emoticonId: emoticon.id } });
  res.status(204).end();
});

const forkSchema = z.object({
  name: z.string().min(1).max(40),
  trigger: z.string().min(2).max(40).regex(/^:[a-z0-9_]+:$/),
  imageUrl: z.string().min(1).optional(),
});

emoticonsRouter.post("/:id/fork", requireAuth, async (req, res) => {
  const parent = await prisma.emoticon.findUnique({ where: { protocolId: req.params.id } });
  if (!parent) return res.status(404).json({ error: "not_found" });
  if (!parent.allowFork) return res.status(403).json({ error: "forking_not_allowed" });

  const parsed = forkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  if (await isTriggerTaken(req.userId!, parsed.data.trigger)) {
    return res.status(409).json({ error: "trigger_already_in_use" });
  }

  const fork = await prisma.emoticon.create({
    data: {
      protocolId: newProtocolId(),
      creatorId: req.userId!,
      name: parsed.data.name,
      trigger: parsed.data.trigger,
      imageUrl: parsed.data.imageUrl ?? parent.imageUrl,
      parentId: parent.id,
    },
    include: { creator: true, parent: { include: { creator: true } } },
  });
  res.status(201).json({ emoticon: serialize(fork) });
});

// `:id` is the caller's own fork. Pulls the original's *current* image into
// it, on demand. The name, trigger and allow* flags all stay the fork owner's:
// the name is chosen when forking (and would otherwise be silently overwritten
// by the first sync even if nothing upstream changed). Deliberately no allowFork check against
// the original: that flag gates creating new forks, not syncing an
// already-established one (same shape as closing registration not kicking out
// existing users).
emoticonsRouter.post("/:id/sync", requireAuth, async (req, res) => {
  const fork = await prisma.emoticon.findUnique({ where: { protocolId: req.params.id } });
  if (!fork) return res.status(404).json({ error: "not_found" });
  if (fork.creatorId !== req.userId) return res.status(403).json({ error: "forbidden" });
  // parentId is nulled by the schema's onDelete: SetNull when the original is
  // deleted, so "not a fork" and "original is gone" are the same condition.
  if (!fork.parentId) return res.status(404).json({ error: "not_a_fork" });

  const parent = await prisma.emoticon.findUniqueOrThrow({ where: { id: fork.parentId } });
  const updated = await prisma.emoticon.update({
    where: { id: fork.id },
    data: { imageUrl: parent.imageUrl },
    include: { creator: true, parent: { include: { creator: true } } },
  });
  res.json({ emoticon: serialize(updated) });
});

// Name, image, and whether others may save/fork it. The trigger is
// deliberately not editable: it's what every message and every save/fork keys
// on, so changing it would silently break existing references. Saves mirror an
// edit immediately (they point at this row); forks pick up a new image only
// when their owner syncs. Turning allowSave/allowFork off only stops *new*
// saves/forks - existing ones keep working (see the save and sync handlers).
const updateSchema = z
  .object({
    name: z.string().min(1).max(40).optional(),
    imageUrl: z.string().min(1).optional(),
    allowSave: z.boolean().optional(),
    allowFork: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), { message: "nothing to update" });

emoticonsRouter.patch("/:id", requireAuth, async (req, res) => {
  const emoticon = await prisma.emoticon.findUnique({ where: { protocolId: req.params.id } });
  if (!emoticon) return res.status(404).json({ error: "not_found" });
  if (!(await canManageEmoticon(emoticon, req.userId!))) return res.status(403).json({ error: "forbidden" });

  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const updated = await prisma.emoticon.update({
    where: { id: emoticon.id },
    data: parsed.data,
    include: { creator: true, parent: { include: { creator: true } } },
  });
  res.json({ emoticon: serialize(updated) });
});

emoticonsRouter.delete("/:id", requireAuth, async (req, res) => {
  const emoticon = await prisma.emoticon.findUnique({ where: { protocolId: req.params.id } });
  if (!emoticon) return res.status(404).json({ error: "not_found" });
  if (!(await canManageEmoticon(emoticon, req.userId!))) return res.status(403).json({ error: "forbidden" });

  await prisma.emoticon.delete({ where: { id: emoticon.id } });
  res.status(204).end();
});
