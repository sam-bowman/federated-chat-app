import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import * as api from "../api";
import type { Community, Conversation, FriendRequest, PublicUser } from "../api";
import { PREFETCH_KEYS, takePrefetched } from "../lib/bootPrefetch";
import { useAuth } from "./AuthContext";
import { useWs } from "./WsContext";

interface AppDataContextValue {
  conversations: Conversation[];
  communities: Community[];
  /** False until the first list has arrived, so "not in the list" can mean gone rather than not loaded yet. */
  communitiesLoaded: boolean;
  friends: PublicUser[];
  incomingRequests: FriendRequest[];
  refreshConversations: () => Promise<void>;
  refreshCommunities: () => Promise<void>;
  refreshFriends: () => Promise<void>;
  refreshRequests: () => Promise<void>;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { subscribe } = useWs();
  const { applyPresence } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [communitiesLoaded, setCommunitiesLoaded] = useState(false);
  const [friends, setFriends] = useState<PublicUser[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<FriendRequest[]>([]);

  const refreshConversations = async () => setConversations(await api.listConversations());
  const refreshCommunities = async () => {
    setCommunities(await api.listCommunities());
    setCommunitiesLoaded(true);
  };
  const refreshFriends = async () => setFriends(await api.listFriends());
  const refreshRequests = async () => setIncomingRequests(await api.listFriendRequests("incoming"));

  useEffect(() => {
    // The first answers were asked for at the start of the page load, before this was drawn (lib/bootPrefetch.ts); anything not asked for
    // then is asked for now. Every later refresh asks the server.
    const loaded = <T,>(key: string, ask: () => Promise<T>, use: (value: T) => void) =>
      void (takePrefetched<T>(key) ?? ask()).then(use).catch(() => undefined);
    loaded(PREFETCH_KEYS.conversations, api.listConversations, setConversations);
    loaded(PREFETCH_KEYS.communities, api.listCommunities, (list) => {
      setCommunities(list);
      setCommunitiesLoaded(true);
    });
    loaded(PREFETCH_KEYS.friends, api.listFriends, setFriends);
    loaded(PREFETCH_KEYS.incomingRequests, () => api.listFriendRequests("incoming"), setIncomingRequests);
  }, []);

  useEffect(() => {
    const unsubs = [
      subscribe("conversation:created", () => void refreshConversations()),
      subscribe("message:created", () => {
        void refreshConversations();
        void refreshCommunities();
      }),
      subscribe("message:edited", () => void refreshConversations()),
      subscribe("message:deleted", () => void refreshConversations()),
      subscribe("friend_request:created", () => void refreshRequests()),
      subscribe("friend_request:cancelled", () => void refreshRequests()),
      subscribe("friend_request:accepted", () => {
        void refreshFriends();
      }),
      subscribe("friend:removed", () => void refreshFriends()),
      // Someone deleted their account (#60): they are no longer a friend, a member or a chat partner, and their messages are gone.
      subscribe("user:deleted", () => {
        void refreshFriends();
        void refreshRequests();
        void refreshConversations();
        void refreshCommunities();
      }),
      subscribe("channel:created", () => void refreshCommunities()),
      // Fired locally after a federated community's cache is resynced (or
      // dropped, if we're no longer a member) - see
      // server/src/modules/federation/routes.ts's POST
      // /communities/:id/updated handler.
      subscribe("community:updated", () => void refreshCommunities()),
      // The owner deleted a community we were in.
      subscribe("community:deleted", () => void refreshCommunities()),
      // Your own status changed, here or on another device, or you just connected and the server marked you
      // online: the event says what it is now, so the footer and Settings show the status you really have. Your status is
      // otherwise only read when you sign in, before the connection that makes you online exists. (It used to ask for the whole
      // person again every time, which is a second `me` on every page load.)
      subscribe("presence:self", (payload: { status: string; customStatus: string | null }) =>
        applyPresence(payload.status as PublicUser["presence"]["status"], payload.customStatus ?? null)
      ),
      subscribe("presence", (payload: { userId: string; status: string; customStatus: string | null }) => {
        setFriends((prev) =>
          prev.map((f) =>
            f.id === payload.userId
              ? { ...f, presence: { ...f.presence, status: payload.status as any, customStatus: payload.customStatus } }
              : f
          )
        );
        setConversations((prev) =>
          prev.map((c) => ({
            ...c,
            members: c.members.map((m) =>
              m.id === payload.userId
                ? { ...m, presence: { ...m.presence, status: payload.status as any, customStatus: payload.customStatus } }
                : m
            ),
          }))
        );
      }),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe]);

  return (
    <AppDataContext.Provider
      value={{
        conversations,
        communities,
        communitiesLoaded,
        friends,
        incomingRequests,
        refreshConversations,
        refreshCommunities,
        refreshFriends,
        refreshRequests,
      }}
    >
      {children}
    </AppDataContext.Provider>
  );
}

/** The app's lists if there are any (a page rendered on its own has none), for something that only wants names from them. */
export function useOptionalAppData() {
  return useContext(AppDataContext);
}

export function useAppData() {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData must be used within AppDataProvider");
  return ctx;
}
