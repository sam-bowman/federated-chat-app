-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('MESSAGE', 'USER', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ReportScope" AS ENUM ('COMMUNITY', 'SERVER');

-- CreateTable
CREATE TABLE "Report" (
    "id" SERIAL NOT NULL,
    "protocolId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "ReportKind" NOT NULL,
    "scope" "ReportScope" NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "reporterId" TEXT,
    "reporterLabel" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "targetLabel" TEXT,
    "communityId" TEXT,
    "snapshot" JSONB NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedByLabel" TEXT,
    "action" TEXT,
    "note" TEXT,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Report_protocolId_key" ON "Report"("protocolId");

-- CreateIndex
CREATE INDEX "Report_communityId_status_id_idx" ON "Report"("communityId", "status", "id");

-- CreateIndex
CREATE INDEX "Report_scope_status_id_idx" ON "Report"("scope", "status", "id");

-- CreateIndex
CREATE INDEX "Report_targetUserId_idx" ON "Report"("targetUserId");

-- CreateIndex
CREATE INDEX "Report_createdAt_idx" ON "Report"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporterId_targetKey_key" ON "Report"("reporterId", "targetKey");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
