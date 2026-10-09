import { prisma } from "../../src/db.js";

// Listed leaf-to-root isn't actually required - CASCADE plus naming every
// table in one TRUNCATE handles ordering regardless - but kept roughly
// dependency-ordered for readability against schema.prisma.
const TABLES = [
  "SyncEvent",
  "Reaction",
  "Attachment",
  "Message",
  "EmoticonSave",
  "Emoticon",
  "ChannelRead",
  "Channel",
  "MemberRole",
  "Role",
  "CommunityBan",
  "CommunityMember",
  "Community",
  "ConversationMember",
  "Conversation",
  "Friendship",
  "Block",
  "FriendRequest",
  "RefreshToken",
  "FederationOutboxEvent",
  "FederationPeer",
  "ServerIdentity",
  "User",
];

export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE;`);
}

export async function disconnectDb() {
  await prisma.$disconnect();
}
