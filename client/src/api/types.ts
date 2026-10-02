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
  presence: Presence;
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

export interface Message {
  id: string;
  sender: PublicUser;
  content: string | null;
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
}

export interface Community {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  owner: PublicUser;
  createdAt: string;
  channels: Channel[];
  roles: Role[];
  members: CommunityMember[];
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
  createdAt: string;
}

export interface SyncEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
