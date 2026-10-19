-- AlterTable
ALTER TABLE "User" ADD COLUMN     "registrationInviteId" TEXT;

-- CreateTable
CREATE TABLE "RegistrationInvite" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3),
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInvite_code_key" ON "RegistrationInvite"("code");

-- CreateIndex
CREATE INDEX "User_registrationInviteId_idx" ON "User"("registrationInviteId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_registrationInviteId_fkey" FOREIGN KEY ("registrationInviteId") REFERENCES "RegistrationInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
