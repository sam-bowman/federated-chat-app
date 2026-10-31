import type { Prisma, User } from "../../generated/prisma/client.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rateLimit.js";
import { verifyPassword } from "../../lib/auth.js";
import { exportAccountData } from "./exportData.js";
import { publicUser } from "../../lib/serialize.js";
import { setCustomStatus, setPresenceInMemory } from "../presence/presenceStore.js";
import { findLocalUserByUsername } from "../../lib/users.js";
import { parseAccentColor, parsePronouns } from "../../lib/profileFields.js";
import { refreshRemoteProfile } from "../federation/remoteUsers.js";
import { discoverabilityLocked } from "../../lib/userDiscoverability.js";
import { CONTACT_POLICIES } from "../../lib/contactPolicy.js";
import { listingLocked } from "../../lib/directoryPeople.js";
import { verifyTotpLogin } from "../auth/totp.js";
import { literally } from "../../lib/likeSearch.js";
import { recordAudit } from "../audit/service.js";
import { identityFor } from "../../lib/ids.js";
import { requestDeletion } from "./deletion.js";
import { param } from "../../lib/params.js";

export const usersRouter = Router();

usersRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ user: selfUser(user) });
});

// Download of everything this server holds about the signed-in person (#60; modules/users/exportData.ts says what is and is not in
// it). It asks for the password again, as turning on 2FA does: a stolen access token must not be enough to take someone's whole
// history. It is a POST so the password is in a body and not an address, and it is streamed, so a long history is never all in
// memory. Behind the sign-in limiter, since it is a way to guess a password.
const exportSchema = z.object({ password: z.string().min(1) });

usersRouter.post("/me/export", authLimiter, requireAuth, async (req, res) => {
  const parsed = exportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user?.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  res.status(200);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="chat-export-${user.username}-${new Date().toISOString().slice(0, 10)}.json"`);
  // Nothing on the way keeps a copy of someone's whole history.
  res.setHeader("Cache-Control", "no-store");
  try {
    for await (const chunk of exportAccountData(user.id)) {
      if (!res.write(chunk)) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
    res.end();
  } catch (err) {
    // Half a file is worse than none: cut the connection so the download fails rather than looking complete.
    console.error("[export] failed for an account:", err);
    res.destroy();
  }
});

// Asking for the account to be deleted (#60, modules/users/deletion.ts says what that means). It is the most destructive thing a person
// can do, so it wants everything that proves it is them AND that they mean it: the password, the username typed out, and a code from
// their authenticator when they have one. It does not erase anything yet: it ends their sessions and starts the grace period, in which
// signing in again cancels it. Refused while they own a community (409 `owns_communities`, with the list), which they transfer or
// delete first. Behind the sign-in limiter, since it is a way to guess a password.
const deleteAccountSchema = z.object({
  password: z.string().min(1),
  username: z.string().min(1).max(100),
  code: z.string().min(1).optional(),
  recoveryCode: z.string().min(1).optional(),
});

usersRouter.post("/me/delete", authLimiter, requireAuth, async (req, res) => {
  const parsed = deleteAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || user.deletedAt || !user.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  if (parsed.data.username.trim().toLowerCase() !== user.username) return res.status(400).json({ error: "username_mismatch" });
  if (user.totpEnabled && !(await verifyTotpLogin(user.id, { code: parsed.data.code, recoveryCode: parsed.data.recoveryCode }))) {
    return res.status(401).json({ error: "invalid_code" });
  }

  const result = await requestDeletion(user.id);
  if (!result.ok) {
    if (result.error === "owns_communities") return res.status(409).json({ error: "owns_communities", communities: result.communities });
    return res.status(404).json({ error: "not_found" });
  }
  if (!result.alreadyRequested) {
    await recordAudit({ source: "api", action: "account.delete_request", actor: { kind: "user", user }, target: { type: "user", id: user.protocolId, label: identityFor(user.username, user.homeserverDomain) }, details: { scheduledFor: result.scheduledFor.toISOString() } });
  }
  res.status(202).json({ scheduledFor: result.scheduledFor, graceDays: config.accountDeletionGraceDays });
});

/** The signed-in person as they see themselves: the public view plus whether the server has taken the findability choice away. */
function selfUser(user: User) {
  return {
    ...publicUser(user, user.id),
    // An admin can only use the page while the server has it switched on.
    isAdmin: user.isAdmin && config.adminEnabled,
    discoverabilityLocked: discoverabilityLocked(config.userDiscoverability),
    // Whether this server publishes a directory at all: being listed does nothing where it does not.
    directoryEnabled: config.directoryEnabled,
    // Whether it lists people at all, and the widest anyone's contact setting may be here (a person's own choice only narrows it).
    directoryPeopleLocked: listingLocked(config.directoryPeople),
    contactPolicyLimit: config.contactPolicyLimit,
  };
}

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
  // Whether servers with no relationship to this person may find them (lib/userDiscoverability.ts).
  discoverable: z.boolean().optional(),
  // Who may send them a friend request or start a conversation (lib/contactPolicy.ts).
  contactPolicy: z.enum(CONTACT_POLICIES).optional(),
  // Whether to be listed in the server's directory of people (lib/directory.ts). Only counts while findable.
  listedInDirectory: z.boolean().optional(),
});

usersRouter.patch("/me", requireAuth, async (req, res) => {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  // A server that has switched findability off for everyone has taken the choice away: say so rather than accept a setting
  // that would silently do nothing.
  if ((parsed.data.discoverable !== undefined || parsed.data.listedInDirectory !== undefined) && discoverabilityLocked(config.userDiscoverability)) {
    return res.status(409).json({ error: "discoverability_locked" });
  }

  if (parsed.data.listedInDirectory !== undefined && listingLocked(config.directoryPeople)) {
    return res.status(409).json({ error: "directory_listing_locked" });
  }

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
  res.json({ user: selfUser(user) });
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
    where: { username: { contains: literally(q) }, homeserverDomain: config.domain, isRemote: false, deletedAt: null },
    take: 20,
  });

  res.json({ users: users.filter((u) => !excluded.has(u.id)).map((u) => publicUser(u, req.userId!)) });
});

usersRouter.get("/:username", requireAuth, async (req, res) => {
  const user = await findLocalUserByUsername(param(req, "username"));
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
  const subject = await prisma.user.findUnique({ where: { protocolId: param(req, "id") } });
  // An account that was deleted has no profile (#60): what is left is a tombstone, not a person.
  if (!subject || subject.deletedAt) return res.status(404).json({ error: "not_found" });

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
