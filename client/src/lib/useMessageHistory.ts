import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { Message } from "../api";
import { withArrivals } from "./arrivals";
import { cachedHistory, rememberHistory } from "./messageCache";

interface History {
  /** The chat these messages are of. */
  id: string | undefined;
  messages: Message[];
  hasMore: boolean;
  /** Whether what is shown is known: from the server, or kept from the last time this chat was open. */
  loaded: boolean;
}

/**
 * The messages of the chat that is open (a channel or a conversation), for the two pages that show them (#237).
 *
 * What it guarantees, which the pages used to get wrong:
 * - **Another chat's messages are never shown.** The page is not rebuilt when only the chat changes, so its messages used to stay on screen,
 *   under the new chat's name, until the new ones arrived. When `id` changes the messages are reset in the same render, before anything is drawn.
 * - **A chat looked at before opens at once**, from what was kept (lib/messageCache.ts), while the server is asked for the current messages,
 *   which replace it when they arrive.
 * - **`loaded` is false until there is something true to show**, so "No messages yet" is not said about a chat whose messages are on their way.
 * - A change made for one chat (a send, a reaction) that finishes after the person has moved on is ignored rather than put into the new chat.
 * - A live message that lands while the history is on its way is kept (see `withArrivals`): call `noteArrival` for each one. Only WHICH
 *   messages arrived is remembered; their text is taken from the page's own list when the history lands, so whatever happened to them since
 *   (an edit, a delete, their sender's account being erased) is kept, not undone by an older copy.
 */
export function useMessageHistory(userId: string | undefined, id: string | undefined, load: (id: string) => Promise<Message[]>) {
  const start = (forId: string | undefined): History => {
    const kept = forId ? cachedHistory(userId, forId) : undefined;
    return { id: forId, messages: kept?.messages ?? [], hasMore: kept?.hasMore ?? false, loaded: kept !== undefined };
  };
  const [history, setHistory] = useState<History>(() => start(id));
  let shown = history;
  if (history.id !== id) {
    // Another chat: start again from what is kept for it, in this very render (setting state while rendering is how React derives state from a prop).
    shown = start(id);
    setHistory(shown);
  }

  const arrived = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!id) return;
    let current = true;
    arrived.current = new Set();
    load(id)
      .then((page) => {
        if (!current) return; // switched chats while it loaded
        // The ids are taken now, not inside the update below: that runs later, by when the set has been let go of.
        const live = arrived.current ?? new Set<string>();
        arrived.current = null;
        setHistory((h) => ({
          id,
          // The server's copy of everything it has; plus the live ones it did not have yet, as they are NOW in the list (not as they arrived).
          messages: withArrivals(page, h.messages.filter((m) => live.has(m.id))),
          hasMore: page.length >= api.MESSAGE_PAGE_SIZE,
          loaded: true,
        }));
      })
      .catch(() => {
        // A chat that was left is not this one's business: what is waiting to be merged belongs to the chat that is open now.
        if (!current) return;
        // Could not be loaded: what was kept (or nothing) stays, and it is no longer "on its way".
        setHistory((h) => ({ ...h, loaded: true }));
        arrived.current = null;
      });
    return () => {
      current = false;
    };
    // Asked again when the chat changes, not whenever the page makes a new `load` function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (id && shown.loaded) rememberHistory(userId, id, shown.messages, shown.hasMore);
  }, [userId, id, shown.loaded, shown.messages, shown.hasMore]);

  // Bound to the chat of this render: a handler made for chat A that runs after the person is in chat B changes nothing in B.
  const setMessages = useCallback(
    (update: Message[] | ((prev: Message[]) => Message[])) =>
      setHistory((h) => (h.id !== id ? h : { ...h, messages: typeof update === "function" ? update(h.messages) : update })),
    [id]
  );
  const setHasMore = useCallback((hasMore: boolean) => setHistory((h) => (h.id !== id ? h : { ...h, hasMore })), [id]);
  const noteArrival = useCallback((message: Message) => {
    arrived.current?.add(message.id);
  }, []);

  return { messages: shown.messages, hasMore: shown.hasMore, loaded: shown.loaded, setMessages, setHasMore, noteArrival };
}
