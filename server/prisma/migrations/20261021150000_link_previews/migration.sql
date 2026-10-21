-- AlterTable
ALTER TABLE "Message" ADD COLUMN "embeds" JSONB,
ADD COLUMN "embedsRemoved" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LinkPreviewCache" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "siteName" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkPreviewCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkPreviewCache_url_key" ON "LinkPreviewCache"("url");

-- CreateIndex
CREATE INDEX "LinkPreviewCache_fetchedAt_idx" ON "LinkPreviewCache"("fetchedAt");
