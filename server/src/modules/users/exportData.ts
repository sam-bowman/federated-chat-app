import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";

// Everything this server holds ABOUT one person (#60), as a file they can keep. What goes in is decided by one rule: it is the
// person's own data or a plain pointer to someone else (an address and a name), never anything another person wrote, and never a
// secret. So:
//   in:  their account, who they know, the communities and chats they are in, what THEY sent (and have not deleted), what they
//        reacted with, the emoticons they made or saved, and their notification choices;
//   out: other people's messages (a conversation's other side is theirs), messages the person deleted, password hash, 2FA secret
//        and recovery codes, sessions and tokens, and anything about a person on another server beyond how to name them.
// Built by hand, field by field, so a column added to a table later is not exported (or leaked) until someone decides it should be.

/** How many messages are read at a time, so a long history is never all in memory. A test makes it small. */
export let exportBatchSize = 500;
export function setExportBatchSizeForTests(size: number): void {
  exportBatchSize = size;
}

const identityOf = (user: { username: string; homeserverDomain: string }) => `@${user.username}:${user.homeserverDomain}`;
const absolute = (url: string) => toAbsoluteMediaUrl(url, config.baseUrl);
const iso = (date: Date | null) => (date ? date.toISOString() : null);

/** The export as pieces of JSON text, to be written to the response one after the other. */
export async function* exportAccountData(userId: string): AsyncGenerator<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const key = (name: string, value: unknown) => `${JSON.stringify(name)}:${JSON.stringify(value)}`;

  yield "{";
  yield [
    key("format", "federated-chat-export"),
    key("version", 1),
    key("exportedAt", new Date().toISOString()),
    key("server", { domain: config.domain, name: config.serverName }),
    key("account", {
      username: user.username,
      identity: identityOf(user),
      protocolId: user.protocolId,
      displayName: user.displayName,
      bio: user.bio,
      pronouns: user.pronouns,
      accentColor: user.accentColor,
      avatarUrl: user.avatarUrl ? absolute(user.avatarUrl) : null,
      createdAt: user.createdAt.toISOString(),
      lastSeenAt: iso(user.lastSeenAt),
      customStatus: user.customStatus,
      twoFactorEnabled: user.totpEnabled,
      discoverable: user.discoverable,
      contactPolicy: user.contactPolicy,
      listedInDirectory: user.listedInDirectory,
    }),
  ].join(",");

  const friendships = await prisma.friendship.findMany({ where: { userId }, include: { friend: true }, orderBy: { createdAt: "asc" } });
  yield `,${key(
    "friends",
    friendships.map((f) => ({ identity: identityOf(f.friend), displayName: f.friend.displayName, since: f.createdAt.toISOString() }))
  )}`;

  const requests = await prisma.friendRequest.findMany({
    where: { status: "PENDING", OR: [{ fromUserId: userId }, { toUserId: userId }] },
    include: { fromUser: true, toUser: true },
    orderBy: { createdAt: "asc" },
  });
  const describe = (r: (typeof requests)[number], other: typeof r.fromUser) => ({
    identity: identityOf(other),
    displayName: other.displayName,
    message: r.message,
    sentAt: r.createdAt.toISOString(),
  });
  yield `,${key("friendRequests", {
    incoming: requests.filter((r) => r.toUserId === userId).map((r) => describe(r, r.fromUser)),
    outgoing: requests.filter((r) => r.fromUserId === userId).map((r) => describe(r, r.toUser)),
  })}`;

  const blocks = await prisma.block.findMany({ where: { blockerId: userId }, include: { blocked: true }, orderBy: { createdAt: "asc" } });
  yield `,${key("blocked", blocks.map((b) => ({ identity: identityOf(b.blocked), since: b.createdAt.toISOString() })))}`;

  const memberships = await prisma.communityMember.findMany({
    where: { userId },
    include: { community: true, roles: { include: { role: true } } },
    orderBy: { joinedAt: "asc" },
  });
  yield `,${key(
    "communities",
    memberships.map((m) => ({
      id: m.community.protocolId,
      name: m.community.name,
      hostedBy: m.community.homeserverDomain,
      owner: m.community.ownerId === userId,
      nickname: m.nickname,
      joinedAt: m.joinedAt.toISOString(),
      roles: m.roles.map((r) => r.role.name),
    }))
  )}`;

  const conversations = await prisma.conversationMember.findMany({
    where: { userId },
    include: { conversation: { include: { members: { include: { user: true } } } } },
    orderBy: { joinedAt: "asc" },
  });
  yield `,${key(
    "conversations",
    conversations.map((c) => ({
      id: c.conversation.protocolId,
      type: c.conversation.type,
      title: c.conversation.title,
      members: c.conversation.members.map((m) => identityOf(m.user)),
      joinedAt: c.joinedAt.toISOString(),
    }))
  )}`;

  // The messages they sent, oldest first, a batch at a time. A deleted message is not exported: it is gone.
  yield `,${JSON.stringify("messages")}:[`;
  let cursor: { createdAt: Date; id: string } | null = null;
  let first = true;
  for (;;) {
    const batch: Awaited<ReturnType<typeof readMessages>> = await readMessages(userId, cursor);
    for (const message of batch) {
      yield (first ? "" : ",") + JSON.stringify(shapeMessage(message));
      first = false;
    }
    if (batch.length < exportBatchSize) break;
    const last = batch[batch.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }
  yield "]";

  const reactions = await prisma.reaction.findMany({ where: { userId }, include: { message: { select: { protocolId: true } } }, orderBy: { createdAt: "asc" } });
  yield `,${key(
    "reactions",
    reactions.map((r) => ({
      messageId: r.message.protocolId,
      emoji: r.emoji,
      emoticon: r.emoticonProtocolId ? { id: r.emoticonProtocolId, name: r.emoticonName } : null,
      createdAt: r.createdAt.toISOString(),
    }))
  )}`;

  const created = await prisma.emoticon.findMany({ where: { creatorId: userId }, orderBy: { createdAt: "asc" } });
  const saved = await prisma.emoticonSave.findMany({ where: { userId }, include: { emoticon: true }, orderBy: { savedAt: "asc" } });
  yield `,${key("emoticons", {
    created: created.map((e) => ({ name: e.name, trigger: e.trigger, imageUrl: absolute(e.imageUrl), createdAt: e.createdAt.toISOString() })),
    saved: saved.map((s) => ({ name: s.emoticon.name, trigger: s.trigger ?? s.emoticon.trigger, imageUrl: absolute(s.emoticon.imageUrl), savedAt: s.savedAt.toISOString() })),
  })}`;

  const settings = await prisma.notificationSetting.findMany({ where: { userId }, orderBy: { updatedAt: "asc" } });
  yield `,${key(
    "notificationSettings",
    settings.map((s) => ({ type: s.targetType, id: s.targetId || null, sound: s.sound, notify: s.notify }))
  )}`;

  yield "}";
}

function readMessages(userId: string, cursor: { createdAt: Date; id: string } | null) {
  return prisma.message.findMany({
    where: {
      senderId: userId,
      deletedAt: null,
      ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: exportBatchSize,
    include: {
      attachments: true,
      conversation: { select: { protocolId: true } },
      channel: { select: { protocolId: true, name: true, community: { select: { protocolId: true, name: true } } } },
      replyTo: { select: { protocolId: true } },
    },
  });
}

function shapeMessage(m: Awaited<ReturnType<typeof readMessages>>[number]) {
  return {
    id: m.protocolId,
    where: m.conversation
      ? { conversationId: m.conversation.protocolId }
      : m.channel
        ? { communityId: m.channel.community.protocolId, communityName: m.channel.community.name, channelId: m.channel.protocolId, channelName: m.channel.name }
        : {},
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    editedAt: iso(m.editedAt),
    replyTo: m.replyTo?.protocolId ?? null,
    attachments: m.attachments.map((a) => ({ url: absolute(a.url), filename: a.filename, contentType: a.contentType, size: a.size })),
  };
}
