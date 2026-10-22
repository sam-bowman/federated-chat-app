import type { Message } from "../api";

// The latest page of messages of the chats looked at in this session, so going back to one shows it at once while the server is asked for
// the current one (#237). It is only ever a stand-in: the page replaces it with what the server says as soon as that arrives, so a message that
// was edited, deleted or sent while away is right within one round trip; nothing here is trusted for longer than that.
//
// In memory only (gone with the page), for ONE person at a time (a different signed-in account starts empty, so nothing of one person's chats
// can show for another on a shared device), and bounded: the newest page of each of the last few chats, never the whole history.

/** How many messages of one chat are kept: the newest page, which is what a chat opens on. */
export const CACHED_PER_CHAT = 50;
/** How many chats are kept; the one longest unused goes first. */
export const MAX_CACHED_CHATS = 30;

export interface CachedHistory {
  messages: Message[];
  /** Whether older messages exist than the ones kept. */
  hasMore: boolean;
}

let owner: string | undefined;
const entries = new Map<string, CachedHistory>();

function ownedBy(userId: string | undefined) {
  if (owner !== userId) {
    entries.clear();
    owner = userId;
  }
}

/** What was kept for this chat, or nothing. Using it makes it the most recently used. */
export function cachedHistory(userId: string | undefined, chatId: string): CachedHistory | undefined {
  ownedBy(userId);
  const entry = entries.get(chatId);
  if (entry) {
    entries.delete(chatId);
    entries.set(chatId, entry);
  }
  return entry;
}

/** Keeps the newest page of this chat's messages (and says if there were more than were kept). */
export function rememberHistory(userId: string | undefined, chatId: string, messages: Message[], hasMore: boolean): void {
  if (!userId) return;
  ownedBy(userId);
  const newest = messages.slice(-CACHED_PER_CHAT);
  entries.delete(chatId);
  entries.set(chatId, { messages: newest, hasMore: hasMore || newest.length < messages.length });
  while (entries.size > MAX_CACHED_CHATS) entries.delete(entries.keys().next().value as string);
}

/** Forgets everything (for tests, and for anything that ends a session). */
export function clearHistoryCache(): void {
  entries.clear();
}
