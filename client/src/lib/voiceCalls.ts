import type { Conversation, ConversationCalls } from "../api";
import { isOnAnotherServer } from "./federation";
import { isEnabled, type PrefsIndex } from "./notificationPrefs";
import type { VoicePeople } from "./voiceChannels";

// Calls in direct and group conversations (#54). Pure helpers: which conversations can be called, who is calling, and whether a call
// should ring.

/** A call needs everyone in the conversation to be on this person's own server: the room is on that server's voice server. */
export function canCallConversation(conversation: Conversation, selfIdentity: string): boolean {
  return !conversation.members.some((m) => isOnAnotherServer(m.identity, selfIdentity));
}

/** What to call a conversation in words: the other person for a direct one, the title for a group. */
export function conversationName(conversation: Conversation | undefined, selfId: string): string {
  if (!conversation) return "call";
  if (conversation.type === "DM") return conversation.members.find((m) => m.id !== selfId)?.displayName ?? "call";
  return conversation.title ?? "Group chat";
}

/**
 * What the list of calls says, folded into what was known. A list that says it cannot be trusted changes nothing ("I do not know",
 * never "nobody is calling"). A list that can be trusted is the whole answer for the conversations asked about, so one it leaves
 * out has no call going: its people are cleared.
 */
export function mergeCalls(prev: VoicePeople, answer: ConversationCalls, conversationIds: readonly string[]): VoicePeople {
  if (!answer.available) return prev;
  let next = prev;
  for (const id of conversationIds) {
    const people = answer.calls[id] ?? [];
    const known = prev[id] ?? [];
    if (known.length === people.length && known.every((p, i) => p === people[i])) continue;
    if (next === prev) next = { ...prev };
    (next as Record<string, readonly string[]>)[id] = people;
  }
  return next;
}

export interface IncomingCall {
  conversation: Conversation;
  /** Who is in the call, by name, for the person to see who is calling. */
  callers: string[];
}

/**
 * The calls this person could answer: a conversation they can call that has someone in a call they are not in, and that they have
 * not put away. Calls go away on their own when the last person leaves.
 */
export function incomingCalls(
  conversations: readonly Conversation[],
  people: VoicePeople,
  selfId: string,
  selfIdentity: string,
  inCallWith: string | null,
  dismissed: ReadonlySet<string>
): IncomingCall[] {
  const out: IncomingCall[] = [];
  for (const conversation of conversations) {
    const ids = people[conversation.id];
    if (!ids || ids.length === 0 || ids.includes(selfId)) continue;
    if (inCallWith === conversation.id || dismissed.has(conversation.id)) continue;
    if (!canCallConversation(conversation, selfIdentity)) continue;
    const callers = ids.map((id) => conversation.members.find((m) => m.id === id)?.displayName).filter((n): n is string => !!n);
    if (callers.length > 0) out.push({ conversation, callers });
  }
  return out;
}

/**
 * Whether a call that has just started rings and shows a system notification. Not while you are on Do not disturb, and the choices
 * you made for that conversation (muting its sound, or its notifications) apply to its calls too. Being in that conversation's window
 * does not quiet it: a call is somebody waiting.
 */
export function decideRing(selfStatus: string | undefined, prefs: PrefsIndex, conversationId: string): { sound: boolean; notify: boolean } {
  if (selfStatus === "DO_NOT_DISTURB") return { sound: false, notify: false };
  const place = { conversationId };
  return { sound: isEnabled(prefs, "sound", place), notify: isEnabled(prefs, "notify", place) };
}
