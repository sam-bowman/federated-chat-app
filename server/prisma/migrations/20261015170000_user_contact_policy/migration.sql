-- Who may send a person a friend request or start a conversation with them (#109 phase 3). Everyone starts open, as before.
CREATE TYPE "ContactPolicy" AS ENUM ('ANYONE', 'SHARED_COMMUNITY', 'LOCAL_ONLY');
ALTER TABLE "User" ADD COLUMN "contactPolicy" "ContactPolicy" NOT NULL DEFAULT 'ANYONE';
