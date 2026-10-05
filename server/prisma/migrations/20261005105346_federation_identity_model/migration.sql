-- DropIndex
DROP INDEX "User_username_key";

-- AlterTable: add the new columns first as nullable/defaulted so existing
-- rows don't violate NOT NULL, backfill them, then tighten the constraint.
ALTER TABLE "User" ADD COLUMN     "homeserverBaseUrl" TEXT,
ADD COLUMN     "homeserverDomain" TEXT,
ADD COLUMN     "isRemote" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- Backfill: every existing row is, by definition, a local user on this
-- server's own domain (federation didn't exist before this migration).
UPDATE "User" SET "homeserverDomain" = 'localhost' WHERE "homeserverDomain" IS NULL;

ALTER TABLE "User" ALTER COLUMN "homeserverDomain" SET NOT NULL;

-- CreateTable
CREATE TABLE "ServerIdentity" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederationPeer" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederationPeer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FederationPeer_domain_key" ON "FederationPeer"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_homeserverDomain_key" ON "User"("username", "homeserverDomain");
