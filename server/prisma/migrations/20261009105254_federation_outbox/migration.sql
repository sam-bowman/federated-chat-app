-- CreateEnum
CREATE TYPE "FederationOutboxStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'FAILED');

-- CreateTable
CREATE TABLE "FederationOutboxEvent" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "status" "FederationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederationOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FederationOutboxEvent_status_nextAttemptAt_idx" ON "FederationOutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "FederationOutboxEvent_domain_idx" ON "FederationOutboxEvent"("domain");
