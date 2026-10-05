import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { wsUrl, sync } from "../api";
import { ensureFreshAccessToken } from "../api/client";
import { useAuth } from "./AuthContext";

type Listener = (payload: any) => void;

interface WsContextValue {
  subscribe: (type: string, listener: Listener) => () => void;
  sendTyping: (target: { conversationId?: string; channelId?: string }) => void;
}

const WsContext = createContext<WsContextValue | null>(null);

const CURSOR_KEY = "chat.syncCursor";

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
      let cursor = localStorage.getItem(CURSOR_KEY) ?? undefined;
      // Resumable sync: replay anything that happened while we were offline
      // (or on first load) before trusting live WebSocket events.
      for (let i = 0; i < 20; i++) {
        const page = await sync(cursor);
        for (const event of page.events) {
          dispatch(event.type, event.payload);
        }
        cursor = page.nextCursor;
        localStorage.setItem(CURSOR_KEY, cursor);
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
