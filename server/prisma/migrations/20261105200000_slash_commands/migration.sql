-- CreateEnum
CREATE TYPE "InteractionState" AS ENUM ('RECEIVED', 'DEFERRED', 'DONE');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "interaction" JSONB;

-- CreateTable
CREATE TABLE "BotCommand" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interaction" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "commandId" TEXT,
    "commandName" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "ephemeral" BOOLEAN NOT NULL DEFAULT false,
    "state" "InteractionState" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotCommand_protocolId_key" ON "BotCommand"("protocolId");

-- CreateIndex
CREATE UNIQUE INDEX "BotCommand_botId_name_key" ON "BotCommand"("botId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Interaction_protocolId_key" ON "Interaction"("protocolId");

-- CreateIndex
CREATE INDEX "Interaction_botId_state_idx" ON "Interaction"("botId", "state");

-- CreateIndex
CREATE INDEX "Interaction_createdAt_idx" ON "Interaction"("createdAt");

-- AddForeignKey
ALTER TABLE "BotCommand" ADD CONSTRAINT "BotCommand_botId_fkey" FOREIGN KEY ("botId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_botId_fkey" FOREIGN KEY ("botId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "BotCommand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- USE_COMMANDS is permission bit 13 (8192). Everyone could talk to a bot before there was a permission for it, so every community's default
-- (@everyone) role gets it; a manager can take it away. Written by value: do not renumber the bit.
UPDATE "Role" SET "permissions" = "permissions" | 8192 WHERE "isDefault" = true;
