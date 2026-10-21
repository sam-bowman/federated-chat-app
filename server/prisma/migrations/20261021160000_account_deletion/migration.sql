-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeletedUsername" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeletedUsername_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeletedUsername_username_key" ON "DeletedUsername"("username");
