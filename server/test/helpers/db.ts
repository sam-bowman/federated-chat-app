import { prisma } from "../../src/db.js";
import { resetFederationOutboxStateForTests, waitForPendingDeliveries } from "../../src/lib/federation/outbox.js";
import { describeDatabaseTarget, formatDatabaseTarget, isTestDatabaseUrl } from "../../src/lib/databaseTarget.js";

// Every table, leaf to root. resetDb() deletes them in this order, so a table that points at another
// without ON DELETE CASCADE has to come first; add a new table before the ones it references.
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

// Emptied with DELETE in one transaction, not TRUNCATE. TRUNCATE ... CASCADE rewrites the files of every
// table it names and syncs them to disk: ~300 ms for these 24 tables on a development machine, paid
// before every one of the suite's ~290 tests (the largest single cost in it). Deleting the handful of
// rows a test left behind takes ~6 ms. The order is the TABLES list above (leaf to root), which is what
// the foreign keys need: DELETE, unlike TRUNCATE ... CASCADE, will not reach past one that has no
// ON DELETE CASCADE (Community.ownerId, for one).
export async function resetDb() {
  // Emptying every table is only ever acceptable on a database made for tests. Refuse anywhere else,
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
  // Federation deliveries now happen in the background after the request returns. Let the last test's finish
  // before its rows are deleted from under them, and forget which peers it left looking dead.
  await waitForPendingDeliveries();
  resetFederationOutboxStateForTests();
  await prisma.$transaction([
    ...TABLES.map((t) => prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)),
    // TRUNCATE ... RESTART IDENTITY used to put the auto-increment counters back to 1 for every test;
    // DELETE does not, so do it explicitly for the one table that has one.
    prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"SyncEvent"', 'seq'), 1, false)`),
  ]);
}

export async function disconnectDb() {
  await prisma.$disconnect();
}
