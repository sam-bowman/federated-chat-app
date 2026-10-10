-- AlterTable
ALTER TABLE "User" ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpLastUsedStep" INTEGER,
ADD COLUMN     "totpSecret" TEXT;

-- CreateTable
CREATE TABLE "TotpRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TotpRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TotpRecoveryCode_userId_idx" ON "TotpRecoveryCode"("userId");

-- AddForeignKey
ALTER TABLE "TotpRecoveryCode" ADD CONSTRAINT "TotpRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
