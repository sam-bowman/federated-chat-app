import { prisma } from "../../src/db.js";
import { describeDatabaseTarget, formatDatabaseTarget, isTestDatabaseUrl } from "../../src/lib/databaseTarget.js";

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
  "TotpRecoveryCode",
  "FederationOutboxEvent",
  "FederationPeer",
  "ServerIdentity",
  "User",
];

export async function resetDb() {
  // Truncating every table is only ever acceptable on a database made for tests. Refuse anywhere else,
  // before touching anything (see isTestDatabaseUrl for how the real dev database got wiped once).
  const url = process.env.DATABASE_URL;
  if (!isTestDatabaseUrl(url)) {
    const target = url ? describeDatabaseTarget(url) : null;
    throw new Error(
      `Refusing to reset ${target ? formatDatabaseTarget(target) : "an unknown database"}: its name must end in "_test" ` +
        "(the integration tests use chat_test). Run them with `npm run test:integration --workspace server`, never with a bare " +
        "`npx vitest run`, which does not point them at the test database."
    );
  }
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE;`);
}

export async function disconnectDb() {
  await prisma.$disconnect();
}
