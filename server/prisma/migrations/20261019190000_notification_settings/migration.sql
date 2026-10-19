-- What a person wants to hear and see when a message arrives, for everything and for one community, channel or conversation.
-- A null sound or notify means "use the next level up"; nothing set anywhere means on.

CREATE TYPE "NotificationTargetType" AS ENUM ('GLOBAL', 'COMMUNITY', 'CHANNEL', 'CONVERSATION');

CREATE TABLE "NotificationSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetType" "NotificationTargetType" NOT NULL,
    "targetId" TEXT NOT NULL DEFAULT '',
    "sound" BOOLEAN,
    "notify" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSetting_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationSetting_userId_idx" ON "NotificationSetting"("userId");

CREATE UNIQUE INDEX "NotificationSetting_userId_targetType_targetId_key" ON "NotificationSetting"("userId", "targetType", "targetId");

ALTER TABLE "NotificationSetting" ADD CONSTRAINT "NotificationSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
