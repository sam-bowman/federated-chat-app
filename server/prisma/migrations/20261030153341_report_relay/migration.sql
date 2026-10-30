-- AlterEnum
ALTER TYPE "ReportScope" ADD VALUE 'REMOTE';

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "reporterDomain" TEXT;

-- CreateIndex
CREATE INDEX "Report_reporterDomain_createdAt_idx" ON "Report"("reporterDomain", "createdAt");
