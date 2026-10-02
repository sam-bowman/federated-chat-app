import type { Attachment, Message, Reaction, User } from "@prisma/client";
import { publicUser } from "../../lib/serialize.js";

type MessageWithRelations = Message & {
  sender: User;
  attachments: Attachment[];
  reactions: (Reaction & { user: User })[];
  replyTo: (Message & { sender: User }) | null;
};

export function serializeMessage(message: MessageWithRelations) {
  const reactionsByEmoji = new Map<string, { emoji: string; count: number; users: string[] }>();
  for (const r of message.reactions ?? []) {
    const entry = reactionsByEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, users: [] };
    entry.count += 1;
    entry.users.push(r.user.username);
    reactionsByEmoji.set(r.emoji, entry);
  }

  return {
    id: message.protocolId,
    sender: publicUser(message.sender),
    content: message.deletedAt ? null : message.content,
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
    reactions: [...reactionsByEmoji.values()],
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    createdAt: message.createdAt,
  };
}

export type SerializedMessage = ReturnType<typeof serializeMessage>;
