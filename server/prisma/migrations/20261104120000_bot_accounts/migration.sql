-- AlterTable
ALTER TABLE "User" ADD COLUMN     "botOwnerId" TEXT,
ADD COLUMN     "botTokenHash" TEXT,
ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "User_botTokenHash_key" ON "User"("botTokenHash");

-- CreateIndex
CREATE INDEX "User_botOwnerId_idx" ON "User"("botOwnerId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_botOwnerId_fkey" FOREIGN KEY ("botOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
