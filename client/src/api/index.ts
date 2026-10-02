import { apiRequest, setTokens, clearTokens } from "./client";
import type {
  Channel,
  Community,
  Conversation,
  Emoticon,
  FriendRequest,
  Message,
  PublicUser,
  SyncEvent,
} from "./types";

export * from "./types";
export { mediaUrl, wsUrl, getAccessToken } from "./client";

export async function register(username: string, password: string, displayName?: string) {
  const data = await apiRequest<{ user: PublicUser; accessToken: string; refreshToken: string }>(
    "/api/v1/auth/register",
    { method: "POST", body: { username, password, displayName }, skipAuth: true }
  );
  setTokens(data.accessToken, data.refreshToken);
  return data.user;
}

export async function login(username: string, password: string) {
  const data = await apiRequest<{ user: PublicUser; accessToken: string; refreshToken: string }>(
    "/api/v1/auth/login",
    { method: "POST", body: { username, password }, skipAuth: true }
  );
  setTokens(data.accessToken, data.refreshToken);
  return data.user;
}

export function logout() {
  clearTokens();
}

export const me = () => apiRequest<{ user: PublicUser }>("/api/v1/users/me").then((r) => r.user);

export const updateMe = (patch: { displayName?: string; bio?: string | null; avatarUrl?: string | null }) =>
  apiRequest<{ user: PublicUser }>("/api/v1/users/me", { method: "PATCH", body: patch }).then((r) => r.user);

export const setPresence = (patch: { status?: string; customStatus?: string | null }) =>
  apiRequest<{ user: PublicUser }>("/api/v1/users/me/presence", { method: "PATCH", body: patch }).then((r) => r.user);

export const searchUsers = (q: string) =>
  apiRequest<{ users: PublicUser[] }>(`/api/v1/users/search?q=${encodeURIComponent(q)}`).then((r) => r.users);

export const sendFriendRequest = (username: string, message?: string) =>
  apiRequest<{ request: FriendRequest }>("/api/v1/friends/requests", { method: "POST", body: { username, message } });

export const listFriendRequests = (direction?: "incoming" | "outgoing") =>
  apiRequest<{ requests: FriendRequest[] }>(
    `/api/v1/friends/requests${direction ? `?direction=${direction}` : ""}`
  ).then((r) => r.requests);

export const acceptFriendRequest = (id: string) =>
  apiRequest<{ friend: PublicUser }>(`/api/v1/friends/requests/${id}/accept`, { method: "POST" });

export const declineFriendRequest = (id: string) =>
  apiRequest<void>(`/api/v1/friends/requests/${id}/decline`, { method: "POST" });

export const cancelFriendRequest = (id: string) =>
  apiRequest<void>(`/api/v1/friends/requests/${id}/cancel`, { method: "POST" });

export const listFriends = () => apiRequest<{ friends: PublicUser[] }>("/api/v1/friends").then((r) => r.friends);

export const removeFriend = (userId: string) => apiRequest<void>(`/api/v1/friends/${userId}`, { method: "DELETE" });

export const blockUser = (username: string) =>
  apiRequest<void>("/api/v1/friends/blocks", { method: "POST", body: { username } });

export const unblockUser = (userId: string) =>
  apiRequest<void>(`/api/v1/friends/blocks/${userId}`, { method: "DELETE" });

export const listBlocked = () =>
  apiRequest<{ blocked: PublicUser[] }>("/api/v1/friends/blocks").then((r) => r.blocked);

export const listConversations = () =>
  apiRequest<{ conversations: Conversation[] }>("/api/v1/conversations").then((r) => r.conversations);

export const createConversation = (type: "DM" | "GROUP", memberUsernames: string[], title?: string) =>
  apiRequest<{ conversation: Conversation }>("/api/v1/conversations", {
    method: "POST",
    body: { type, memberUsernames, title },
  }).then((r) => r.conversation);

export const getConversation = (id: string) =>
  apiRequest<{ conversation: Conversation }>(`/api/v1/conversations/${id}`).then((r) => r.conversation);

export const markConversationRead = (id: string) =>
  apiRequest<void>(`/api/v1/conversations/${id}/read`, { method: "POST" });

export const leaveConversation = (id: string) =>
  apiRequest<void>(`/api/v1/conversations/${id}/members/me`, { method: "DELETE" });

export const listMessages = (conversationId: string, before?: string) =>
  apiRequest<{ messages: Message[] }>(
    `/api/v1/conversations/${conversationId}/messages${before ? `?before=${before}` : ""}`
  ).then((r) => r.messages);

export const sendMessage = (
  conversationId: string,
  content: string,
  opts?: { replyToId?: string; attachments?: { url: string; filename: string; contentType: string; size: number }[] }
) =>
  apiRequest<{ message: Message }>(`/api/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: { content, ...opts },
  }).then((r) => r.message);

export const editMessage = (messageId: string, content: string) =>
  apiRequest<{ message: Message }>(`/api/v1/messages/${messageId}`, { method: "PATCH", body: { content } });

export const deleteMessage = (messageId: string) =>
  apiRequest<void>(`/api/v1/messages/${messageId}`, { method: "DELETE" });

export const addReaction = (messageId: string, emoji: string) =>
  apiRequest<{ message: Message }>(`/api/v1/messages/${messageId}/reactions`, { method: "POST", body: { emoji } });

export const removeReaction = (messageId: string, emoji: string) =>
  apiRequest<{ message: Message }>(`/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
    method: "DELETE",
  });

export const listCommunities = () =>
  apiRequest<{ communities: Community[] }>("/api/v1/communities").then((r) => r.communities);

export const createCommunity = (name: string, description?: string) =>
  apiRequest<{ community: Community }>("/api/v1/communities", { method: "POST", body: { name, description } }).then(
    (r) => r.community
  );

export const getCommunity = (id: string) =>
  apiRequest<{ community: Community }>(`/api/v1/communities/${id}`).then((r) => r.community);

export const updateCommunity = (id: string, patch: { name?: string; description?: string | null }) =>
  apiRequest<{ community: Community }>(`/api/v1/communities/${id}`, { method: "PATCH", body: patch }).then(
    (r) => r.community
  );

export const joinCommunity = (id: string) =>
  apiRequest<{ community: Community }>(`/api/v1/communities/${id}/members`, { method: "POST" }).then(
    (r) => r.community
  );

export const leaveCommunity = (id: string) =>
  apiRequest<void>(`/api/v1/communities/${id}/members/me`, { method: "DELETE" });

export const createChannel = (communityId: string, name: string, topic?: string) =>
  apiRequest<{ channel: Channel }>(`/api/v1/communities/${communityId}/channels`, {
    method: "POST",
    body: { name, topic },
  }).then((r) => r.channel);

export const listChannelMessages = (channelId: string, before?: string) =>
  apiRequest<{ messages: Message[] }>(`/api/v1/channels/${channelId}/messages${before ? `?before=${before}` : ""}`).then(
    (r) => r.messages
  );

export const sendChannelMessage = (channelId: string, content: string, replyToId?: string) =>
  apiRequest<{ message: Message }>(`/api/v1/channels/${channelId}/messages`, {
    method: "POST",
    body: { content, replyToId },
  }).then((r) => r.message);

export const markChannelRead = (channelId: string) =>
  apiRequest<void>(`/api/v1/channels/${channelId}/read`, { method: "POST" });

export const listEmoticons = () =>
  apiRequest<{ personal: Emoticon[]; saved: Emoticon[]; community: Emoticon[] }>("/api/v1/emoticons");

export const createEmoticon = (data: {
  name: string;
  trigger: string;
  imageUrl: string;
  communityId?: string;
}) => apiRequest<{ emoticon: Emoticon }>("/api/v1/emoticons", { method: "POST", body: data }).then((r) => r.emoticon);

export const saveEmoticon = (id: string, trigger?: string) =>
  apiRequest<void>(`/api/v1/emoticons/${id}/save`, { method: "POST", body: trigger ? { trigger } : undefined });

export const unsaveEmoticon = (id: string) => apiRequest<void>(`/api/v1/emoticons/${id}/save`, { method: "DELETE" });

export const deleteEmoticon = (id: string) => apiRequest<void>(`/api/v1/emoticons/${id}`, { method: "DELETE" });

export async function uploadFile(file: File): Promise<{ url: string; filename: string; contentType: string; size: number }> {
  const form = new FormData();
  form.append("file", file);
  return apiRequest("/api/v1/media/upload", { method: "POST", body: form, isForm: true });
}

export const sync = (cursor?: string) =>
  apiRequest<{ events: SyncEvent[]; nextCursor: string; hasMore: boolean }>(
    `/api/v1/sync${cursor ? `?cursor=${cursor}` : ""}`
  );
