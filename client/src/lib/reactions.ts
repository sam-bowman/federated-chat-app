import type { Message, Reaction, ReactionChoice } from "../api";

/** The five reactions offered on every message before the picker. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢"];

/** What a reaction pill stands for: an emoticon by its id, or an emoji by itself. Two that look alike stay two. */
export function reactionKey(r: Reaction | ReactionChoice): string {
  if ("emoticon" in r && r.emoticon) return `e:${r.emoticon.id}`;
  return `u:${"emoji" in r ? (r.emoji ?? "") : ""}`;
}

export function choiceOf(r: Reaction): ReactionChoice {
  return r.emoticon ? { emoticon: r.emoticon } : { emoji: r.emoji ?? "" };
}

/** Whether this person already has this reaction on the message. */
export function hasReacted(message: Pick<Message, "reactions">, choice: ReactionChoice, username: string): boolean {
  const key = reactionKey(choice);
  return message.reactions.some((r) => reactionKey(r) === key && r.users.includes(username));
}
