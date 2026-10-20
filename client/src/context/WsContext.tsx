import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { wsUrl, sync } from "../api";
import { ensureFreshAccessToken, SYNC_CURSOR_KEY } from "../api/client";
import { useAuth } from "./AuthContext";

type Listener = (payload: any) => void;

interface WsContextValue {
  subscribe: (type: string, listener: Listener) => () => void;
  sendTyping: (target: { conversationId?: string; channelId?: string }) => void;
}

const WsContext = createContext<WsContextValue | null>(null);

export function WsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // Only the identity of the logged-in user should reopen the socket - a
  // profile/presence refresh produces a new `user` object on every call
  // (see AuthContext.refreshUser), and reconnecting on that churn makes the
  // server briefly see the user as offline-then-online again, silently
  // reverting any manually-set presence status (e.g. BUSY) back to ONLINE.
  const userId = user?.id ?? null;
  const listeners = useRef(new Map<string, Set<Listener>>());
  const socketRef = useRef<WebSocket | null>(null);

  const dispatch = (type: string, payload: any) => {
    listeners.current.get(type)?.forEach((fn) => fn(payload));
    listeners.current.get("*")?.forEach((fn) => fn({ type, ...payload }));
  };

  useEffect(() => {
    if (!userId) return;

    let cancelled = false;
    let reconnectDelay = 1000;
    let socket: WebSocket | null = null;

    async function catchUp() {
      let cursor = localStorage.getItem(SYNC_CURSOR_KEY) ?? undefined;
      // Resumable sync: replay anything that happened while we were offline
      // (or on first load) before trusting live WebSocket events.
      for (let i = 0; i < 20; i++) {
        const page = await sync(cursor);
        for (const event of page.events) {
          // Marked, so what only wants things as they happen (an alert for a new message) can leave these alone: replaying is how a
          // client catches up on what it missed, but it also hands back events it already saw live, after every reconnection.
          dispatch(event.type, { ...event.payload, replayed: true });
        }
        cursor = page.nextCursor;
        localStorage.setItem(SYNC_CURSOR_KEY, cursor);
        if (!page.hasMore) break;
      }
    }

    async function connect() {
      if (cancelled) return;
      await ensureFreshAccessToken();
      if (cancelled) return;

      socket = new WebSocket(wsUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        reconnectDelay = 1000;
        void catchUp();
        // For what keeps state that is only ever pushed (never replayed by the sync above), such as who is in a voice
        // channel: the connection is back, so ask again.
        dispatch("ws:open", {});
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          dispatch(data.type, data);
        } catch {
          // ignore malformed frames
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      };
    }

    connect();

    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [userId]);

  const subscribe = (type: string, listener: Listener) => {
    if (!listeners.current.has(type)) listeners.current.set(type, new Set());
    listeners.current.get(type)!.add(listener);
    return () => listeners.current.get(type)?.delete(listener);
  };

  const sendTyping = (target: { conversationId?: string; channelId?: string }) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "typing", ...target }));
    }
  };

  return <WsContext.Provider value={{ subscribe, sendTyping }}>{children}</WsContext.Provider>;
}

export function useWs() {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error("useWs must be used within WsProvider");
  return ctx;
}
