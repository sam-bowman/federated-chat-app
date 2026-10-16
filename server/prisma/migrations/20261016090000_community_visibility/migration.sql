-- Who may join a community (#109 phase 4), replacing the yes/no "openJoin". Every community keeps what it had:
-- one that let anyone with its id join stays that way (UNLISTED), one that needed an invite still does (INVITE_ONLY).
CREATE TYPE "CommunityVisibility" AS ENUM ('UNLISTED', 'INVITE_ONLY', 'LOCAL_ONLY');
ALTER TABLE "Community" ADD COLUMN "visibility" "CommunityVisibility" NOT NULL DEFAULT 'UNLISTED';
UPDATE "Community" SET "visibility" = 'INVITE_ONLY' WHERE "openJoin" = false;
ALTER TABLE "Community" DROP COLUMN "openJoin";
