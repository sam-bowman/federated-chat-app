import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import * as api from "../api";
import type { Community, Conversation, FriendRequest, PublicUser } from "../api";
import { useWs } from "./WsContext";

interface AppDataContextValue {
  conversations: Conversation[];
  communities: Community[];
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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [friends, setFriends] = useState<PublicUser[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<FriendRequest[]>([]);

  const refreshConversations = async () => setConversations(await api.listConversations());
  const refreshCommunities = async () => setCommunities(await api.listCommunities());
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
      subscribe("message:created", () => void refreshConversations()),
      subscribe("message:edited", () => void refreshConversations()),
      subscribe("message:deleted", () => void refreshConversations()),
      subscribe("friend_request:created", () => void refreshRequests()),
      subscribe("friend_request:cancelled", () => void refreshRequests()),
      subscribe("friend_request:accepted", () => {
        void refreshFriends();
      }),
      subscribe("friend:removed", () => void refreshFriends()),
      subscribe("channel:created", () => void refreshCommunities()),
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
