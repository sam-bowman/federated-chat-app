import { Router } from "express";
import { z } from "zod";
import type { Emoticon, User } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { newProtocolId } from "../../lib/ids.js";
import { publicUser } from "../../lib/serialize.js";

export const emoticonsRouter = Router();

function serialize(e: Emoticon & { creator: User }) {
  return {
    id: e.protocolId,
    name: e.name,
    trigger: e.trigger,
    imageUrl: e.imageUrl,
    creator: publicUser(e.creator),
    communityId: e.communityId,
    allowSave: e.allowSave,
    allowExport: e.allowExport,
    allowFork: e.allowFork,
    parentId: e.parentId,
    createdAt: e.createdAt,
  };
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
    prisma.emoticon.findMany({ where: { creatorId: req.userId!, communityId: null }, include: { creator: true } }),
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
    personal: created.map(serialize),
    saved: saved.map((s) => serialize(s.emoticon)),
    community: community.map(serialize),
  });
});

emoticonsRouter.post("/:id/save", requireAuth, async (req, res) => {
  const emoticon = await prisma.emoticon.findUnique({ where: { protocolId: req.params.id } });
  if (!emoticon) return res.status(404).json({ error: "not_found" });
  if (!emoticon.allowSave) return res.status(403).json({ error: "saving_not_allowed" });

  await prisma.emoticonSave.upsert({
    where: { userId_emoticonId: { userId: req.userId!, emoticonId: emoticon.id } },
    create: { userId: req.userId!, emoticonId: emoticon.id },
    update: {},
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

  const fork = await prisma.emoticon.create({
    data: {
      protocolId: newProtocolId(),
      creatorId: req.userId!,
      name: parsed.data.name,
      trigger: parsed.data.trigger,
      imageUrl: parsed.data.imageUrl ?? parent.imageUrl,
      parentId: parent.id,
    },
    include: { creator: true },
  });
  res.status(201).json({ emoticon: serialize(fork) });
});

emoticonsRouter.delete("/:id", requireAuth, async (req, res) => {
  const emoticon = await prisma.emoticon.findUnique({ where: { protocolId: req.params.id } });
  if (!emoticon) return res.status(404).json({ error: "not_found" });
  if (emoticon.creatorId !== req.userId) return res.status(403).json({ error: "forbidden" });

  await prisma.emoticon.delete({ where: { id: emoticon.id } });
  res.status(204).end();
});
