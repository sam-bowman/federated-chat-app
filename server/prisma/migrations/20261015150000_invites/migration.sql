-- Invites that can expire, be limited and be revoked, a per-community switch for joining by bare id, and the
-- permission to create invites.

ALTER TABLE "Community" ADD COLUMN "openJoin" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "viaCard" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invite_code_key" ON "Invite"("code");
CREATE INDEX "Invite_communityId_createdAt_idx" ON "Invite"("communityId", "createdAt");

ALTER TABLE "Invite" ADD CONSTRAINT "Invite_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CREATE_INVITE is permission bit 9 (512). Every member could invite before there was such a permission (joining by
-- id was open), so every community's @everyone role gets it: nothing changes until someone takes it away.
UPDATE "Role" SET "permissions" = "permissions" | 512 WHERE "isDefault" = true;
