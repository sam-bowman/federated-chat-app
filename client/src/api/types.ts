export interface Presence {
  status: "ONLINE" | "AWAY" | "BUSY" | "DO_NOT_DISTURB" | "INVISIBLE" | "OFFLINE";
  customStatus: string | null;
  lastSeenAt: string | null;
}

export interface PublicUser {
  id: string;
  identity: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  // Optional: a server older than the profile fields does not send them.
  pronouns?: string | null;
  accentColor?: string | null;
  presence: Presence;
  // Only ever present when looking at your own account - omitted entirely
  // (not false) for anyone else's, same masking the server applies to
  // INVISIBLE presence.
  totpEnabled?: boolean;
  // Also only for your own account. Whether servers with no relationship to you may find you by handle (absent from a server
  // that predates the setting), and whether the server has taken that choice away.
  discoverable?: boolean;
  discoverabilityLocked?: boolean;
  // Who may send you a friend request or start a conversation (absent from a server that predates it): see lib/contact.ts.
  contactPolicy?: "ANYONE" | "SHARED_COMMUNITY" | "LOCAL_ONLY";
  // Also only for your own account: whether you chose to be listed in the server's directory of people, and whether the server
  // publishes a directory at all (absent from a server that predates it).
  listedInDirectory?: boolean;
  directoryEnabled?: boolean;
}

/** A community in a server's directory (listed because its managers made it public). `domain` is the server it lives on. */
export interface DirectoryCommunity {
  id: string;
  domain: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  iconText: string | null;
  iconColor: string | null;
  memberCount: number;
}

/** A person in a server's directory (listed because they chose to be). */
export interface DirectoryPerson {
  id: string;
  username: string;
  domain: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
}

/** One page of a directory. `nextCursor` goes back as `cursor` for the next; null when this was the last. */
export interface DirectoryPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** What someone's profile page says, and how you relate to them (so it can offer the right actions). */
export interface UserProfile {
  user: PublicUser;
  /** When their account was created on their own server; null if unknown (an older server, or one that could not be reached). */
  memberSince: string | null;
  /** False when their own server could not be asked, so this is the copy we already had. */
  homeServerReachable: boolean;
  relationship: {
    isSelf: boolean;
    isFriend: boolean;
    blockedByMe: boolean;
    /** Blocking only works for people on your own server. */
    canBlock: boolean;
    pendingRequest: { id: string; direction: "incoming" | "outgoing" } | null;
  };
}

export interface FriendRequest {
  id: string;
  from: PublicUser;
  to: PublicUser;
  message: string | null;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED";
  createdAt: string;
}

export interface Attachment {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface Reaction {
  emoji: string;
  count: number;
  users: string[];
}

export interface MessageEmoticon {
  id: string;
  trigger: string;
  imageUrl: string;
  name: string;
  allowSave: boolean;
  creatorId: string;
}

/** A direct invitation to a community, carried by a direct message and shown as a card with a Join button. */
export interface InviteCard {
  /** The community's id. */
  communityId: string;
  /** The server it lives on. */
  domain: string;
  /** Its name when the invite was sent. User-entered: show it as text only. */
  name: string;
  /**
   * The invite this card hands over, so it can expire, be used up or be revoked. A card without one is from before
   * invites: it joins by the community's id alone, which works while the community lets anyone join.
   */
  code?: string;
}

export type InviteStatus = "active" | "revoked" | "expired" | "used_up";

/** An invite as its home server lists it: a code that can expire, be limited and be revoked. */
export interface Invite {
  /** What to revoke it by. Null for one just made through another server, which only that server can list or revoke. */
  id: string | null;
  code: string;
  /** Everything to paste into "Join by ID": "<community id>:<server>#<code>". */
  reference: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  revokedAt: string | null;
  /** Made automatically for a card sent to a friend, rather than in the Invite dialog. */
  viaCard: boolean;
  status: InviteStatus;
  createdAt: string;
  createdBy: PublicUser;
}

export interface Message {
  id: string;
  sender: PublicUser;
  content: string | null;
  /** Set when this message is a community invitation; null otherwise. */
  invite: InviteCard | null;
  emoticons: MessageEmoticon[];
  attachments: Attachment[];
  replyTo: { id: string; sender: PublicUser } | null;
  reactions: Reaction[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface ConversationMember extends PublicUser {
  nickname: string | null;
}

export interface Conversation {
  id: string;
  type: "DM" | "GROUP";
  title: string | null;
  createdAt: string;
  members: ConversationMember[];
  lastMessage?: Message | null;
  unread?: boolean;
}

export interface Channel {
  id: string;
  name: string;
  topic: string | null;
  type: "TEXT";
  position: number;
  unread?: boolean;
}

export interface Role {
  id: string;
  name: string;
  color: string | null;
  position: number;
  permissions: string;
  isDefault: boolean;
}

export interface CommunityMember extends PublicUser {
  nickname: string | null;
  joinedAt: string;
  roles: string[];
  roleIds: string[];
}

export interface Community {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  /** The letters (1-3 characters) and background colour (#rrggbb) of the tile when there is no picture; null for the default. */
  iconText: string | null;
  iconColor: string | null;
  /**
   * Who may join: anyone with the community's id (UNLISTED), only people with an invite (INVITE_ONLY) or only accounts on its
   * own server (LOCAL_ONLY). Absent from a server that predates it: see `openJoin` and lib/communityVisibility.ts.
   */
  visibility?: "UNLISTED" | "INVITE_ONLY" | "LOCAL_ONLY" | "PUBLIC";
  /**
   * The old yes/no, still sent by every server: false means a person needs an invite. Absent from a server that predates
   * invites, which means yes.
   */
  openJoin?: boolean;
  /** The server it lives on; with the id, the code to join it from anywhere. */
  homeserverDomain: string;
  owner: PublicUser;
  createdAt: string;
  channels: Channel[];
  roles: Role[];
  members: CommunityMember[];
}

export interface CommunityBan {
  user: PublicUser;
  reason: string | null;
  createdAt: string;
}

export interface EmoticonParent {
  id: string;
  name: string;
  trigger: string;
  creator: PublicUser;
}

export interface Emoticon {
  id: string;
  name: string;
  trigger: string;
  imageUrl: string;
  creator: PublicUser;
  communityId: string | null;
  allowSave: boolean;
  allowExport: boolean;
  allowFork: boolean;
  parentId: string | null;
  // Only sent for the user's own personal emoticons (and fork/sync responses);
  // null there means "not a fork", absent means "not loaded".
  parent?: EmoticonParent | null;
  createdAt: string;
}

export interface SyncEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
