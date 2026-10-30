import { apiDownload, apiRequest, setTokens, clearTokens } from "./client";
import { announceDeletionCancelled } from "../lib/deletionNotice";
import type {
  AdminCommunityDetail,
  AdminOverview,
  AdminCommunityPage,
  AdminRegistrationInvite,
  AdminRegistrationInvites,
  AdminUserDetail,
  AdminUserPage,
  AuditPage,
  ReportKind,
  ReportContext,
  ReportPage,
  ReportReason,
  Report,
  ResolveAction,
  Channel,
  Community,
  CommunityBan,
  CommunityVoice,
  ConversationCalls,
  Conversation,
  DirectoryCommunity,
  DirectoryPage,
  DirectoryPerson,
  Emoticon,
  FriendRequest,
  Message,
  NewRegistrationInvites,
  NotificationSetting,
  NotificationTargetType,
  ReactionChoice,
  PublicUser,
  Invite,
  Role,
  SyncEvent,
  UserProfile,
  VoiceToken,
} from "./types";

export * from "./types";
export { mediaUrl, wsUrl, getAccessToken } from "./client";

export async function register(username: string, password: string, displayName?: string, inviteCode?: string) {
  const data = await apiRequest<{ user: PublicUser; accessToken: string; refreshToken: string }>(
    "/api/v1/auth/register",
    { method: "POST", body: { username, password, displayName, inviteCode }, skipAuth: true }
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
    | { user: PublicUser; accessToken: string; refreshToken: string; deletionCancelled?: true }
  >("/api/v1/auth/login", { method: "POST", body: { username, password }, skipAuth: true });

  if ("totpRequired" in data) {
    return data;
  }
  setTokens(data.accessToken, data.refreshToken);
  // Signing in cancels a request to delete the account; the person is told (components/DeletionCancelledNotice.tsx).
  if (data.deletionCancelled) announceDeletionCancelled();
  return data.user;
}

export async function verifyTotpLogin(
  challengeToken: string,
  input: { code?: string; recoveryCode?: string }
): Promise<PublicUser> {
  const data = await apiRequest<{ user: PublicUser; accessToken: string; refreshToken: string; deletionCancelled?: true }>(
    "/api/v1/auth/2fa/login",
    { method: "POST", body: { challengeToken, ...input }, skipAuth: true }
  );
  setTokens(data.accessToken, data.refreshToken);
  if (data.deletionCancelled) announceDeletionCancelled();
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
  listedInDirectory?: boolean;
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

export const addReaction = (messageId: string, choice: ReactionChoice) =>
  apiRequest<{ message: Message }>(`/api/v1/messages/${messageId}/reactions`, {
    method: "POST",
    body: "emoticon" in choice ? { emoticonId: choice.emoticon.id } : { emoji: choice.emoji },
  });

export const removeReaction = (messageId: string, choice: ReactionChoice) =>
  apiRequest<{ message: Message }>(
    "emoticon" in choice
      ? `/api/v1/messages/${messageId}/emoticon-reactions/${encodeURIComponent(choice.emoticon.id)}`
      : `/api/v1/messages/${messageId}/reactions/${encodeURIComponent(choice.emoji)}`,
    { method: "DELETE" }
  );

export const getNotificationSettings = () =>
  apiRequest<{ settings: NotificationSetting[] }>("/api/v1/notification-settings").then((r) => r.settings);

/** Changes one place's choices; a field left out stays, `null` takes a choice away. */
export const setNotificationSetting = (change: { type: NotificationTargetType; id?: string; sound?: boolean | null; notify?: boolean | null }) =>
  apiRequest<{ setting: NotificationSetting; settings: NotificationSetting[] }>("/api/v1/notification-settings", { method: "PUT", body: change });

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
    /** Who may join: anyone with the community code, only people with an invite, only people on this server, or the public (listed). */
    visibility?: "UNLISTED" | "INVITE_ONLY" | "LOCAL_ONLY" | "PUBLIC";
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
/**
 * One page of a server's directory (#109): this server's own, or `domain`'s, asked for through this one. `q` searches names, `cursor` is
 * the `nextCursor` of the page before. Rejects with the server's error (`directory_disabled` when that server publishes none).
 */
function directoryUrl(kind: "communities" | "people", query: { domain?: string | null; q?: string; cursor?: string | null }) {
  const params = new URLSearchParams();
  if (query.domain) params.set("domain", query.domain);
  if (query.q) params.set("q", query.q);
  if (query.cursor) params.set("cursor", query.cursor);
  const text = params.toString();
  return `/api/v1/directory/${kind}${text ? `?${text}` : ""}`;
}

export const listDirectoryCommunities = (query: { domain?: string | null; q?: string; cursor?: string | null } = {}) =>
  apiRequest<DirectoryPage<DirectoryCommunity>>(directoryUrl("communities", query));

export const listDirectoryPeople = (query: { domain?: string | null; q?: string; cursor?: string | null } = {}) =>
  apiRequest<DirectoryPage<DirectoryPerson>>(directoryUrl("people", query));

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

export const createChannel = (communityId: string, name: string, topic?: string, type?: "TEXT" | "VOICE") =>
  apiRequest<{ channel: Channel }>(`/api/v1/communities/${communityId}/channels`, {
    method: "POST",
    body: { name, topic, type },
  }).then((r) => r.channel);

/** A pass to join a voice channel's room on the voice server. */
export const getVoiceToken = (channelId: string) =>
  apiRequest<VoiceToken>(`/api/v1/channels/${channelId}/voice-token`, { method: "POST" });

/** Everything this server holds about the signed-in person, as a file to save. Asks for the password again. */
export const exportMyData = (password: string) => apiDownload("/api/v1/users/me/export", { password });

/**
 * Asks for the signed-in account to be deleted (it is erased after a grace period, and signing in again cancels it). Needs the password,
 * the username typed out and, with two-factor sign-in on, a code or a recovery code. A 409 `owns_communities` lists what to settle first.
 */
export const deleteMyAccount = (input: { password: string; username: string; code?: string; recoveryCode?: string }) =>
  apiRequest<{ scheduledFor: string; graceDays: number }>("/api/v1/users/me/delete", { method: "POST", body: input });

export interface AdminUserQuery {
  search?: string;
  suspended?: boolean;
  admin?: boolean;
  offset?: number;
  limit?: number;
}

/** Proves, again, that this is the admin (password and a code from the authenticator or a recovery code): answers with a token good for ten minutes. */
export const adminSudo = (input: { password: string; code?: string; recoveryCode?: string }) =>
  apiRequest<{ sudoToken: string; expiresAt: string }>("/api/v1/admin/sudo", { method: "POST", body: input });

/** The accounts on this server, a page at a time. */
export const listAdminUsers = (query: AdminUserQuery = {}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "" && value !== false) params.set(key, String(value));
  const text = params.toString();
  return apiRequest<AdminUserPage>(`/api/v1/admin/users${text ? `?${text}` : ""}`);
};

export const getAdminUser = (username: string) => apiRequest<{ user: AdminUserDetail }>(`/api/v1/admin/users/${encodeURIComponent(username)}`);

const adminUserPath = (username: string, action: string) => `/api/v1/admin/users/${encodeURIComponent(username)}/${action}`;
const withSudo = (sudoToken: string) => ({ "X-Admin-Sudo": sudoToken });

// Everything that changes an account needs the sudo token. Each answers with the account as it is now.
export const adminSuspend = (username: string, sudoToken: string) =>
  apiRequest<{ user: AdminUserDetail }>(adminUserPath(username, "suspend"), { method: "POST", body: {}, headers: withSudo(sudoToken) });
export const adminUnsuspend = (username: string, sudoToken: string) =>
  apiRequest<{ user: AdminUserDetail }>(adminUserPath(username, "unsuspend"), { method: "POST", body: {}, headers: withSudo(sudoToken) });
export const adminResetPassword = (username: string, password: string, sudoToken: string) =>
  apiRequest<{ user: AdminUserDetail }>(adminUserPath(username, "reset-password"), { method: "POST", body: { password }, headers: withSudo(sudoToken) });
export const adminDisableTwoFactor = (username: string, sudoToken: string) =>
  apiRequest<{ user: AdminUserDetail }>(adminUserPath(username, "disable-2fa"), { method: "POST", body: {}, headers: withSudo(sudoToken) });
export const adminCancelDeletion = (username: string, sudoToken: string) =>
  apiRequest<{ user: AdminUserDetail }>(adminUserPath(username, "cancel-deletion"), { method: "POST", body: {}, headers: withSudo(sudoToken) });
/** Asks for the account to be deleted after the waiting period, or (`now`, with the username typed as `confirm`) erases it at once. */
export const adminDeleteUser = (username: string, options: { now?: boolean; confirm?: string }, sudoToken: string) =>
  apiRequest<{ user: AdminUserDetail } | { erased: true }>(adminUserPath(username, "delete"), { method: "POST", body: options, headers: withSudo(sudoToken) });
export const adminSetAdmin = (username: string, admin: boolean, sudoToken: string) =>
  apiRequest<{ user: AdminUserDetail }>(adminUserPath(username, "admin"), { method: "PUT", body: { admin }, headers: withSudo(sudoToken) });

/** The server at a glance: counts and switches. Needs two-factor sign-in, not sudo mode. */
export const getAdminOverview = () => apiRequest<{ overview: AdminOverview }>("/api/v1/admin/overview");

export interface AdminCommunityQuery {
  search?: string;
  offset?: number;
  limit?: number;
}

/** The communities this server hosts, a page at a time. */
export const listAdminCommunities = (query: AdminCommunityQuery = {}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  const text = params.toString();
  return apiRequest<AdminCommunityPage>(`/api/v1/admin/communities${text ? `?${text}` : ""}`);
};

const adminCommunityPath = (id: string, action = "") => `/api/v1/admin/communities/${encodeURIComponent(id)}${action}`;

export const getAdminCommunity = (id: string) => apiRequest<{ community: AdminCommunityDetail }>(adminCommunityPath(id));

/** Hands a community to one of its members, by username. Needs the sudo token. Answers with the community as it is now. */
export const adminTransferCommunity = (id: string, username: string, sudoToken: string) =>
  apiRequest<{ community: AdminCommunityDetail }>(adminCommunityPath(id, "/owner"), { method: "PUT", body: { username }, headers: withSudo(sudoToken) });

/** Deletes a community for good; `confirm` has to be its name. Needs the sudo token. */
export const adminDeleteCommunity = (id: string, confirm: string, sudoToken: string) =>
  apiRequest<{ deleted: true }>(adminCommunityPath(id, "/delete"), { method: "POST", body: { confirm }, headers: withSudo(sudoToken) });

/** The registration invites (newest first): the ones that can still be used, or with `all` every one. Needs two-factor sign-in, not sudo mode. */
export const listAdminRegistrationInvites = (all = false) =>
  apiRequest<AdminRegistrationInvites>(`/api/v1/admin/registration-invites${all ? "?all=1" : ""}`);

/** Makes `count` codes with the same limits. Needs the sudo token. */
export const adminCreateRegistrationInvites = (input: NewRegistrationInvites, sudoToken: string) =>
  apiRequest<{ invites: AdminRegistrationInvite[] }>("/api/v1/admin/registration-invites", { method: "POST", body: input, headers: withSudo(sudoToken) });

/** Stops a code from being used (named by its id, never by the code). Needs the sudo token. */
export const adminRevokeRegistrationInvite = (id: string, sudoToken: string) =>
  apiRequest<{ invite: AdminRegistrationInvite }>(`/api/v1/admin/registration-invites/${encodeURIComponent(id)}/revoke`, { method: "POST", body: {}, headers: withSudo(sudoToken) });

export interface AuditQuery {
  before?: number;
  action?: string;
  source?: string;
  community?: string;
  limit?: number;
}

const auditPath = (base: string, query: AuditQuery) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `${base}?${text}` : base;
};

/** Whether the signed-in person is an admin (the admin page). A 404 means they are not, and that nothing is there. */
export const getAdminMe = () => apiRequest<{ admin: true; twoFactor: boolean }>("/api/v1/admin/me");

/** Everything that was done on this server (admins only; needs two-factor sign-in). */
export const getAdminAuditLog = (query: AuditQuery = {}) => apiRequest<AuditPage>(auditPath("/api/v1/admin/audit-log", query));

/** What the managers of one community did in it (needs the permission to manage it). */
export const getCommunityAuditLog = (communityId: string, query: AuditQuery = {}) =>
  apiRequest<AuditPage>(auditPath(`/api/v1/communities/${communityId}/audit-log`, query));

/** Reports a message, a person or a community (#58). The answer says only that it was received. */
export const reportContent = (input: { kind: ReportKind; id: string; reason: ReportReason; details?: string }) =>
  apiRequest<{ received: true }>("/api/v1/reports", { method: "POST", body: input });

export interface ReportQuery {
  status?: "open" | "resolved" | "dismissed";
  before?: number;
  limit?: number;
}

/** A queue's address: one community's (its reviewers), or the admins' when there is no community. */
const reportsPath = (communityId: string | null, rest = "") =>
  `${communityId ? `/api/v1/communities/${communityId}/reports` : "/api/v1/admin/reports"}${rest}`;

export const listReports = (communityId: string | null, query: ReportQuery = {}) => apiRequest<ReportPage>(auditPath(reportsPath(communityId), query));
/** How many reports are waiting for this reviewer: only a number, cheap enough to ask again and again. */
export const getOpenReportCount = (communityId: string | null) => apiRequest<{ open: number }>(reportsPath(communityId, "/open-count"));
/** The messages around a reported one in a community, for its reviewers (the admins' queue has none). */
export const getReportContext = (communityId: string, id: string) =>
  apiRequest<{ context: ReportContext }>(reportsPath(communityId, `/${encodeURIComponent(id)}/context`));
export const resolveReport = (communityId: string | null, id: string, input: { action: ResolveAction; note?: string }) =>
  apiRequest<{ report: Report }>(reportsPath(communityId, `/${encodeURIComponent(id)}/resolve`), { method: "POST", body: input });
export const dismissReport = (communityId: string | null, id: string, input: { note?: string } = {}) =>
  apiRequest<{ report: Report }>(reportsPath(communityId, `/${encodeURIComponent(id)}/dismiss`), { method: "POST", body: input });
export const reopenReport = (communityId: string | null, id: string) =>
  apiRequest<{ report: Report }>(reportsPath(communityId, `/${encodeURIComponent(id)}/reopen`), { method: "POST", body: {} });

/** Takes the link previews off one of your messages, for everyone. */
export const removeLinkPreviews = (messageId: string) => apiRequest<void>(`/api/v1/messages/${messageId}/embeds`, { method: "DELETE" });

/** A pass to join the call in a direct or group conversation. */
export const getConversationVoiceToken = (conversationId: string) =>
  apiRequest<VoiceToken>(`/api/v1/conversations/${conversationId}/voice-token`, { method: "POST" });

/** Who is in a call right now, for each of this person's conversations that has one. */
export const getConversationCalls = () => apiRequest<ConversationCalls>("/api/v1/conversations/voice");

/** Who is in each of a community's voice channels right now. */
export const getCommunityVoice = (communityId: string) =>
  apiRequest<CommunityVoice>(`/api/v1/communities/${communityId}/voice`);

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
