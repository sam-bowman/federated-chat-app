import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { publicUser } from "../../lib/serialize.js";
import { setCustomStatus, setPresenceInMemory } from "../presence/presenceStore.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { parseAccentColor, parsePronouns } from "../../lib/profileFields.js";
import { refreshRemoteProfile } from "../federation/remoteUsers.js";

export const usersRouter = Router();

usersRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ user: publicUser(user, req.userId!) });
});

const updateMeSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  bio: z.string().max(512).nullable().optional(),
  // Not z.string().url() - avatarUrl is deliberately allowed to be a
  // relative path (the disk storage driver's /uploads/x.png - see
  // schema.prisma's comment on User.homeserverBaseUrl and
  // server/src/lib/storage/), same as Attachment.url and
  // Emoticon.imageUrl elsewhere. .url() would reject exactly what
  // POST /api/v1/media/upload returns under the disk driver, the normal
  // case - confirmed this was actually broken end-to-end before this fix.
  avatarUrl: z.string().min(1).nullable().optional(),
  // Generous bounds here only stop absurd input early; the real rules (length in whole characters, no control
  // characters, #rrggbb) are in lib/profileFields.ts.
  pronouns: z.string().max(200).nullable().optional(),
  accentColor: z.string().max(32).nullable().optional(),
});

usersRouter.patch("/me", requireAuth, async (req, res) => {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  const { pronouns, accentColor, ...rest } = parsed.data;
  const data: Prisma.UserUpdateInput = { ...rest };
  if (pronouns !== undefined) {
    const checked = parsePronouns(pronouns);
    if (!checked.ok) return res.status(400).json({ error: "invalid_pronouns" });
    data.pronouns = checked.value;
  }
  if (accentColor !== undefined) {
    const checked = parseAccentColor(accentColor);
    if (!checked.ok) return res.status(400).json({ error: "invalid_accent_color" });
    data.accentColor = checked.value;
  }

  const user = await prisma.user.update({ where: { id: req.userId! }, data });
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

  // This list backs "add a friend", so leave out everyone who can't usefully be added: yourself,
  // anyone blocked in either direction, existing friends, and anyone with a pending request
  // either way (the request endpoint answers 409 for all of those).
  const [blockedByMe, blockingMe, friendships, pending] = await Promise.all([
    prisma.block.findMany({ where: { blockerId: req.userId! }, select: { blockedId: true } }),
    prisma.block.findMany({ where: { blockedId: req.userId! }, select: { blockerId: true } }),
    prisma.friendship.findMany({ where: { userId: req.userId! }, select: { friendId: true } }),
    prisma.friendRequest.findMany({
      where: { status: "PENDING", OR: [{ fromUserId: req.userId! }, { toUserId: req.userId! }] },
      select: { fromUserId: true, toUserId: true },
    }),
  ]);
  const excluded = new Set([
    req.userId!,
    ...blockedByMe.map((b) => b.blockedId),
    ...blockingMe.map((b) => b.blockerId),
    ...friendships.map((f) => f.friendId),
    ...pending.flatMap((r) => [r.fromUserId, r.toUserId]),
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

/**
 * Someone's profile, as the signed-in user may see it: their public fields, when they joined, and how you
 * relate to them (so the profile can offer the right actions). `:id` is the person's protocol id, the only id the
 * client is ever given, so it works the same for people on this server and on others. For a person on another
 * server their home server is asked for the current profile (see refreshRemoteProfile), falling back to what
 * we already have cached.
 *
 * Someone who has blocked you has no profile for you (404, the same as a person who does not exist). You can
 * still open the profile of someone YOU blocked, which is how you reach Unblock.
 */
usersRouter.get("/:id/profile", requireAuth, async (req, res) => {
  const viewerId = req.userId!;
  const subject = await prisma.user.findUnique({ where: { protocolId: req.params.id } });
  if (!subject) return res.status(404).json({ error: "not_found" });

  const isSelf = subject.id === viewerId;
  const [blockedViewer, blockedByViewer, friendship, pending] = await Promise.all([
    isSelf
      ? null
      : prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: subject.id, blockedId: viewerId } } }),
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: viewerId, blockedId: subject.id } } }),
    prisma.friendship.findUnique({ where: { userId_friendId: { userId: viewerId, friendId: subject.id } } }),
    prisma.friendRequest.findFirst({
      where: {
        status: "PENDING",
        OR: [
          { fromUserId: viewerId, toUserId: subject.id },
          { fromUserId: subject.id, toUserId: viewerId },
        ],
      },
    }),
  ]);
  if (blockedViewer) return res.status(404).json({ error: "not_found" });

  const remote = subject.isRemote ? await refreshRemoteProfile(subject) : null;
  const user = remote?.user ?? subject;

  res.json({
    profile: {
      user: publicUser(user, viewerId),
      memberSince: remote ? remote.memberSince : subject.createdAt,
      // False when the person's own server could not be asked right now: the profile is then what we have cached.
      homeServerReachable: remote ? remote.reachable : true,
      relationship: {
        isSelf,
        isFriend: friendship !== null,
        blockedByMe: blockedByViewer !== null,
        // Blocking is only built for people on this server.
        canBlock: !isSelf && !subject.isRemote,
        pendingRequest: pending ? { id: pending.protocolId, direction: pending.fromUserId === viewerId ? "outgoing" : "incoming" } : null,
      },
    },
  });
});
