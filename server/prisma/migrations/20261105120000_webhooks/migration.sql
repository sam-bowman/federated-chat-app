-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isWebhook" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "createdById" TEXT,
    "name" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_protocolId_key" ON "Webhook"("protocolId");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_senderId_key" ON "Webhook"("senderId");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_secretHash_key" ON "Webhook"("secretHash");

-- CreateIndex
CREATE INDEX "Webhook_communityId_idx" ON "Webhook"("communityId");

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
