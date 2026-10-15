import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import * as api from "../api";
import type { Community, Conversation, FriendRequest, PublicUser } from "../api";
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
  const { refreshUser } = useAuth();
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
    void refreshConversations();
    void refreshCommunities();
    void refreshFriends();
    void refreshRequests();
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
      subscribe("channel:created", () => void refreshCommunities()),
      // Fired locally after a federated community's cache is resynced (or
      // dropped, if we're no longer a member) - see
      // server/src/modules/federation/routes.ts's POST
      // /communities/:id/updated handler.
      subscribe("community:updated", () => void refreshCommunities()),
      // The owner deleted a community we were in.
      subscribe("community:deleted", () => void refreshCommunities()),
      // Your own status changed, here or on another device, or you just connected and the server marked you
      // online: read it again, so the footer and Settings show the status you really have. Your status is
      // otherwise only read when you sign in, before the connection that makes you online exists.
      subscribe("presence:self", () => void refreshUser()),
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

export function useAppData() {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData must be used within AppDataProvider");
  return ctx;
}
