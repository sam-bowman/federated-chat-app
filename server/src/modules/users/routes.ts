import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { publicUser } from "../../lib/serialize.js";
import { setCustomStatus, setPresenceInMemory } from "../presence/presenceStore.js";
import { findLocalUserByUsername } from "../../lib/users.js";

export const usersRouter = Router();

usersRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ user: publicUser(user, req.userId!) });
});

const updateMeSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  bio: z.string().max(512).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

usersRouter.patch("/me", requireAuth, async (req, res) => {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const user = await prisma.user.update({ where: { id: req.userId! }, data: parsed.data });
  res.json({ user: publicUser(user, req.userId!) });
});

const presenceSchema = z.object({
  status: z.enum(["ONLINE", "AWAY", "BUSY", "DO_NOT_DISTURB", "INVISIBLE", "OFFLINE"]).optional(),
  customStatus: z.string().max(128).nullable().optional(),
});

usersRouter.patch("/me/presence", requireAuth, async (req, res) => {
  const parsed = presenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  if (parsed.data.status) {
    await setPresenceInMemory(req.userId!, parsed.data.status);
  }
  if (parsed.data.customStatus !== undefined) {
    await setCustomStatus(req.userId!, parsed.data.customStatus);
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  res.json({ user: publicUser(user!, req.userId!) });
});

usersRouter.get("/search", requireAuth, async (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  if (q.length < 2) return res.json({ users: [] });

  const [blockedByMe, blockingMe] = await Promise.all([
    prisma.block.findMany({ where: { blockerId: req.userId! }, select: { blockedId: true } }),
    prisma.block.findMany({ where: { blockedId: req.userId! }, select: { blockerId: true } }),
  ]);
  const excluded = new Set([
    req.userId!,
    ...blockedByMe.map((b) => b.blockedId),
    ...blockingMe.map((b) => b.blockerId),
  ]);

  // Local directory search only - you can't search someone else's homeserver.
  const users = await prisma.user.findMany({
    where: { username: { contains: q }, homeserverDomain: config.domain, isRemote: false },
    take: 20,
  });

  res.json({ users: users.filter((u) => !excluded.has(u.id)).map((u) => publicUser(u, req.userId!)) });
});

usersRouter.get("/:username", requireAuth, async (req, res) => {
  const user = await findLocalUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ user: publicUser(user, req.userId!) });
});
