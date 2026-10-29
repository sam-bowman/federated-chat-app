// Asks for what the first screen needs at the very start of a page load, all at once, instead of one answer after another (#249).
//
// A reload used to go: the person (`me`), THEN the lists (communities, chats, friends, requests), THEN the open chat's messages, because each
// step only started when the page that needed it had been drawn, and the page was only drawn when the step before had finished. None of them
// needs the answer to another: they need the token, which is already in storage. So they are all asked for in the first moment, and each
// consumer takes the answer when it gets there (`takePrefetched`), falling back to asking itself when there is none.
//
// What keeps this from showing the wrong thing:
// - An answer is taken ONCE, and only for a short while (`MAX_AGE_MS`): anything later asks the server again.
// - It is thrown away on every change of who is signed in or which server this is (`clearBootPrefetch`), so one account's lists can never reach
//   the next person on the same page.
// - It asks only with the token that is stored. No token, no request; a rejected token is refreshed once for all of them (api/client.ts).
// - The server still answers each one for the person who is asking: a chat the person cannot see is a 404 here exactly as it would be later,
//   and a page that finds the answer is not for the chat it is showing does not use it.
import * as api from "../api";
import { getAccessToken, getRefreshToken } from "../api/client";

const MAX_AGE_MS = 15_000;

interface Entry {
  promise: Promise<unknown>;
  at: number;
}

const entries = new Map<string, Entry>();

export const PREFETCH_KEYS = {
  me: "me",
  conversations: "conversations",
  communities: "communities",
  friends: "friends",
  incomingRequests: "friend-requests:incoming",
  channelMessages: (id: string) => `channel-messages:${id}`,
  conversationMessages: (id: string) => `conversation-messages:${id}`,
} as const;

function ask(key: string, run: () => Promise<unknown>) {
  const promise = run();
  // Nobody may be listening yet, and a failure is the consumer's to handle when it asks for the answer: it must not also be an unhandled one here.
  promise.catch(() => undefined);
  entries.set(key, { promise, at: Date.now() });
}

/** The chat the address is of, if it is one: `/communities/<id>/<channel>` or `/dm/<conversation>` (a community alone has no channel yet). */
export function chatInAddress(pathname: string): { kind: "channel" | "conversation"; id: string } | null {
  const channel = pathname.match(/^\/communities\/[^/]+\/([^/]+)\/?$/);
  if (channel) return { kind: "channel", id: decodeURIComponent(channel[1]) };
  const conversation = pathname.match(/^\/dm\/([^/]+)\/?$/);
  if (conversation) return { kind: "conversation", id: decodeURIComponent(conversation[1]) };
  return null;
}

/** Called once, before the page is drawn. Does nothing for a person who is not signed in. */
export function startBootPrefetch(pathname: string): void {
  entries.clear();
  if (!getAccessToken() && !getRefreshToken()) return;
  // Pages with no list of their own to show first (sign-in, register) have nothing to gain.
  if (pathname === "/login" || pathname === "/register") return;

  ask(PREFETCH_KEYS.me, () => api.me());
  ask(PREFETCH_KEYS.conversations, () => api.listConversations());
  ask(PREFETCH_KEYS.communities, () => api.listCommunities());
  ask(PREFETCH_KEYS.friends, () => api.listFriends());
  ask(PREFETCH_KEYS.incomingRequests, () => api.listFriendRequests("incoming"));

  const chat = chatInAddress(pathname);
  if (chat?.kind === "channel") ask(PREFETCH_KEYS.channelMessages(chat.id), () => api.listChannelMessages(chat.id));
  if (chat?.kind === "conversation") ask(PREFETCH_KEYS.conversationMessages(chat.id), () => api.listMessages(chat.id));
}

/** The answer asked for at the start, once, if it is still fresh; otherwise `undefined` and the caller asks for itself. */
export function takePrefetched<T>(key: string): Promise<T> | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  entries.delete(key);
  if (Date.now() - entry.at > MAX_AGE_MS) return undefined;
  return entry.promise as Promise<T>;
}

/** Forgets everything not yet taken. Called when the person signs in, out or switches server, so an answer is never used for anyone else. */
export function clearBootPrefetch(): void {
  entries.clear();
}
