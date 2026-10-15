import { apiRequest, setTokens, clearTokens } from "./client";
import type {
  Channel,
  Community,
  CommunityBan,
  Conversation,
  Emoticon,
  FriendRequest,
  Message,
  PublicUser,
  Invite,
  Role,
  SyncEvent,
  UserProfile,
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

export interface TotpChallenge {
  totpRequired: true;
  challengeToken: string;
}

export async function login(username: string, password: string): Promise<PublicUser | TotpChallenge> {
  const data = await apiRequest<
    | { totpRequired: true; challengeToken: string }
    | { user: PublicUser; accessToken: string; refreshToken: string }
  >("/api/v1/auth/login", { method: "POST", body: { username, password }, skipAuth: true });

  if ("totpRequired" in data) {
    return data;
  }
  setTokens(data.accessToken, data.refreshToken);
  return data.user;
}

export async function verifyTotpLogin(
  challengeToken: string,
  input: { code?: string; recoveryCode?: string }
): Promise<PublicUser> {
  const data = await apiRequest<{ user: PublicUser; accessToken: string; refreshToken: string }>(
    "/api/v1/auth/2fa/login",
    { method: "POST", body: { challengeToken, ...input }, skipAuth: true }
  );
  setTokens(data.accessToken, data.refreshToken);
  return data.user;
}

export const setupTotp = (password: string) =>
  apiRequest<{ secret: string; otpauthUrl: string }>("/api/v1/auth/2fa/setup", {
    method: "POST",
    body: { password },
  });

export const confirmTotpSetup = (code: string) =>
  apiRequest<{ recoveryCodes: string[] }>("/api/v1/auth/2fa/verify", { method: "POST", body: { code } });

export const disableTotp = (password: string) =>
  apiRequest<void>("/api/v1/auth/2fa/disable", { method: "POST", body: { password } });

export function logout() {
  clearTokens();
}

export const me = () => apiRequest<{ user: PublicUser }>("/api/v1/users/me").then((r) => r.user);

export const updateMe = (patch: {
  displayName?: string;
  bio?: string | null;
  avatarUrl?: string | null;
  pronouns?: string | null;
  accentColor?: string | null;
  discoverable?: boolean;
  contactPolicy?: "ANYONE" | "SHARED_COMMUNITY" | "LOCAL_ONLY";
}) => apiRequest<{ user: PublicUser }>("/api/v1/users/me", { method: "PATCH", body: patch }).then((r) => r.user);

/** Someone's profile (by their id), as you may see it. Rejects with a 404 ApiError if there is none for you. */
export const getUserProfile = (userId: string) =>
  apiRequest<{ profile: UserProfile }>(`/api/v1/users/${encodeURIComponent(userId)}/profile`).then((r) => r.profile);

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

/**
 * Invites a friend to a community: opens (or finds) the direct message with them and sends an
 * invitation card into it. The server builds the card from the community's own record, so only
 * which community is sent. Resolves to the message; rejects (ApiError) if, for example, the sender
 * is not a member or the friend's server cannot be reached.
 */
export async function inviteToCommunity(communityId: string, friend: PublicUser): Promise<Message> {
  const conversation = await createConversation("DM", [friend.identity]);
  return apiRequest<{ message: Message }>(`/api/v1/conversations/${conversation.id}/messages`, {
    method: "POST",
    body: { invite: { communityId } },
  }).then((r) => r.message);
}

export const getConversation = (id: string) =>
  apiRequest<{ conversation: Conversation }>(`/api/v1/conversations/${id}`).then((r) => r.conversation);

export const markConversationRead = (id: string) =>
  apiRequest<void>(`/api/v1/conversations/${id}/read`, { method: "POST" });

export const leaveConversation = (id: string) =>
  apiRequest<void>(`/api/v1/conversations/${id}/members/me`, { method: "DELETE" });

// Always sent explicitly, so "a full page came back" reliably means "there may
// be older messages" without depending on the server's default page size.
export const MESSAGE_PAGE_SIZE = 50;

function messagePageQuery(before?: string) {
  const params = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE) });
  if (before) params.set("before", before);
  return params.toString();
}

export const listMessages = (conversationId: string, before?: string) =>
  apiRequest<{ messages: Message[] }>(
    `/api/v1/conversations/${conversationId}/messages?${messagePageQuery(before)}`
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

export const updateCommunity = (
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    /** The picture (an uploaded file's url); null removes it. */
    iconUrl?: string | null;
    /** The tile's letters and colour; null for the default. */
    iconText?: string | null;
    iconColor?: string | null;
    /** Whether anyone with the community id can join; false makes it invite-only. */
    openJoin?: boolean;
  }
) =>
  apiRequest<{ community: Community }>(`/api/v1/communities/${id}`, { method: "PATCH", body: patch }).then(
    (r) => r.community
  );

/** Owner only. Needs the owner's password: it can't be undone by them. */
export const transferCommunityOwner = (id: string, userId: string, password: string) =>
  apiRequest<{ community: Community }>(`/api/v1/communities/${id}/owner`, {
    method: "PUT",
    body: { userId, password },
  }).then((r) => r.community);

/** Owner only. Removes the community with its channels, messages, roles and members. */
export const deleteCommunity = (id: string) => apiRequest<void>(`/api/v1/communities/${id}`, { method: "DELETE" });

/**
 * Joins a community by its id, "<id>:<server>" or either followed by "#<invite code>". Encoded, because a "#" is the
 * start of a URL fragment and would otherwise cut the code off before it left the browser.
 */
export const joinCommunity = (reference: string) =>
  apiRequest<{ community: Community }>(`/api/v1/communities/${encodeURIComponent(reference)}/members`, {
    method: "POST",
  }).then((r) => r.community);

/** Makes an invite. For a community on another server that server makes it (and only it can list or revoke it). */
export const createInvite = (communityId: string, options: { expiresInSeconds?: number | null; maxUses?: number | null } = {}) =>
  apiRequest<{ invite: Invite }>(`/api/v1/communities/${communityId}/invites`, { method: "POST", body: options }).then(
    (r) => r.invite
  );

/** The invites the viewer may see: their own, or everyone's if they can manage the community. Home server only. */
export const listInvites = (communityId: string) =>
  apiRequest<{ invites: Invite[]; seesAll: boolean }>(`/api/v1/communities/${communityId}/invites`);

export const revokeInvite = (communityId: string, inviteId: string) =>
  apiRequest<void>(`/api/v1/communities/${communityId}/invites/${inviteId}`, { method: "DELETE" });

export const leaveCommunity = (id: string) =>
  apiRequest<void>(`/api/v1/communities/${id}/members/me`, { method: "DELETE" });

export const kickMember = (communityId: string, userId: string) =>
  apiRequest<void>(`/api/v1/communities/${communityId}/members/${userId}`, { method: "DELETE" });

export const banMember = (communityId: string, userId: string, reason?: string) =>
  apiRequest<void>(`/api/v1/communities/${communityId}/bans`, { method: "POST", body: { protocolId: userId, reason } });

export const unbanMember = (communityId: string, userId: string) =>
  apiRequest<void>(`/api/v1/communities/${communityId}/bans/${userId}`, { method: "DELETE" });

export const listCommunityBans = (communityId: string) =>
  apiRequest<{ bans: CommunityBan[] }>(`/api/v1/communities/${communityId}/bans`).then((r) => r.bans);

export const createRole = (communityId: string, data: { name: string; color?: string; permissions: string }) =>
  apiRequest<{ role: Role }>(`/api/v1/communities/${communityId}/roles`, { method: "POST", body: data }).then(
    (r) => r.role
  );

export const updateRole = (
  communityId: string,
  roleId: string,
  data: { name?: string; color?: string | null; permissions?: string }
) =>
  apiRequest<{ role: Role }>(`/api/v1/communities/${communityId}/roles/${roleId}`, {
    method: "PATCH",
    body: data,
  }).then((r) => r.role);

export const deleteRole = (communityId: string, roleId: string) =>
  apiRequest<void>(`/api/v1/communities/${communityId}/roles/${roleId}`, { method: "DELETE" });

export const assignRole = (communityId: string, userId: string, roleId: string) =>
  apiRequest<void>(`/api/v1/communities/${communityId}/members/${userId}/roles/${roleId}`, { method: "POST" });

export const unassignRole = (communityId: string, userId: string, roleId: string) =>
  apiRequest<void>(`/api/v1/communities/${communityId}/members/${userId}/roles/${roleId}`, { method: "DELETE" });

export const createChannel = (communityId: string, name: string, topic?: string) =>
  apiRequest<{ channel: Channel }>(`/api/v1/communities/${communityId}/channels`, {
    method: "POST",
    body: { name, topic },
  }).then((r) => r.channel);

export const updateChannel = (
  communityId: string,
  channelId: string,
  data: { name?: string; topic?: string | null }
) =>
  apiRequest<{ channel: Channel }>(`/api/v1/communities/${communityId}/channels/${channelId}`, {
    method: "PATCH",
    body: data,
  }).then((r) => r.channel);

export const deleteChannel = (communityId: string, channelId: string) =>
  apiRequest<void>(`/api/v1/communities/${communityId}/channels/${channelId}`, { method: "DELETE" });

export const reorderChannels = (communityId: string, order: string[]) =>
  apiRequest<{ channels: Channel[] }>(`/api/v1/communities/${communityId}/channels/order`, {
    method: "PUT",
    body: { order },
  }).then((r) => r.channels);

export const listChannelMessages = (channelId: string, before?: string) =>
  apiRequest<{ messages: Message[] }>(`/api/v1/channels/${channelId}/messages?${messagePageQuery(before)}`).then(
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

export const updateEmoticon = (
  id: string,
  data: { name?: string; imageUrl?: string; allowSave?: boolean; allowFork?: boolean }
) =>
  apiRequest<{ emoticon: Emoticon }>(`/api/v1/emoticons/${id}`, { method: "PATCH", body: data }).then(
    (r) => r.emoticon
  );

export const forkEmoticon = (id: string, data: { name: string; trigger: string; imageUrl?: string }) =>
  apiRequest<{ emoticon: Emoticon }>(`/api/v1/emoticons/${id}/fork`, { method: "POST", body: data }).then(
    (r) => r.emoticon
  );

export const syncFork = (id: string) =>
  apiRequest<{ emoticon: Emoticon }>(`/api/v1/emoticons/${id}/sync`, { method: "POST" }).then((r) => r.emoticon);

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
