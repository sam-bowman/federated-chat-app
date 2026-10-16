import type { Attachment, Emoticon, Message, Reaction, User } from "@prisma/client";
import { publicUser } from "../../lib/serialize.js";
import { parseInvite } from "../../lib/invite.js";
import { resolveMessageEmoticons, type ResolvedEmoticon } from "../emoticons/service.js";

type MessageWithRelations = Message & {
  sender: User;
  attachments: Attachment[];
  reactions: (Reaction & { user: User; emoticon: Emoticon | null })[];
  replyTo: (Message & { sender: User }) | null;
};

/**
 * The Prisma `include` that produces exactly a MessageWithRelations -
 * shared by every route that needs to re-fetch a message in
 * serializeMessage()-ready shape (messages/routes.ts's edit/react
 * handlers, federation/routes.ts's received-edit/reaction handlers), so
 * there's one place defining what that shape actually is.
 */
export const messageInclude = {
  sender: true,
  attachments: true,
  reactions: { include: { user: true, emoticon: true } },
  replyTo: { include: { sender: true } },
} as const;

/** One reaction as people see it: a Unicode `emoji`, or a custom `emoticon` (its name and picture, never a trigger). */
export interface SerializedReaction {
  emoji?: string;
  emoticon?: { id: string; name: string; imageUrl: string };
  count: number;
  users: string[];
}

// A custom reaction is its emoticon's id, whichever server it lives on. One of this server's own emoticons is read
// live (so a rename or a new picture shows); one from another server shows what that server sent.
function serializeReactionGroup(r: Reaction & { emoticon: Emoticon | null }): { key: string; entry: SerializedReaction } {
  if (r.emoticonProtocolId) {
    const live = r.emoticon;
    return {
      key: `e:${r.emoticonProtocolId}`,
      entry: {
        emoticon: {
          id: r.emoticonProtocolId,
          name: live?.name ?? r.emoticonName ?? "",
          imageUrl: live?.imageUrl ?? r.emoticonImageUrl ?? "",
        },
        count: 0,
        users: [],
      },
    };
  }
  return { key: `u:${r.emoji}`, entry: { emoji: r.emoji ?? "", count: 0, users: [] } };
}

/**
 * `accessibleEmoticons` must be the SENDER's accessible set (not the
 * viewer's) - it resolves what the sender meant when they typed `:trigger:`,
 * so every recipient sees the same image regardless of their own library.
 */
export function serializeMessage(
  message: MessageWithRelations,
  accessibleEmoticons?: Map<string, ResolvedEmoticon>
) {
  // The database returns them in no particular order, which would shuffle the pills between loads: oldest first,
  // so a reaction keeps its place and a new kind goes on the end.
  const oldestFirst = [...(message.reactions ?? [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const groups = new Map<string, SerializedReaction>();
  for (const r of oldestFirst) {
    const group = serializeReactionGroup(r);
    const entry = groups.get(group.key) ?? group.entry;
    entry.count += 1;
    entry.users.push(r.user.username);
    groups.set(group.key, entry);
  }

  return {
    id: message.protocolId,
    sender: publicUser(message.sender),
    content: message.deletedAt ? null : message.content,
    // A community invitation card, or null for an ordinary message. Re-validated here, so a malformed
    // stored value shows as the message's text instead of a broken card.
    invite: message.deletedAt ? null : parseInvite(message.invite),
    emoticons: message.deletedAt
      ? []
      : resolveMessageEmoticons(message.content, accessibleEmoticons ?? new Map()),
    attachments: message.deletedAt
      ? []
      : (message.attachments ?? []).map((a) => ({
          id: a.id,
          url: a.url,
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
    replyTo: message.replyTo
      ? { id: message.replyTo.protocolId, sender: publicUser(message.replyTo.sender) }
      : null,
    reactions: [...groups.values()],
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    createdAt: message.createdAt,
  };
}

export type SerializedMessage = ReturnType<typeof serializeMessage>;
