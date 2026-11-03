-- AlterTable
ALTER TABLE "LinkPreviewCache" ADD COLUMN "imageUrl" TEXT,
ADD COLUMN "imageWidth" INTEGER,
ADD COLUMN "imageHeight" INTEGER;

-- CreateTable
CREATE TABLE "LinkPreviewImage" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "storedUrl" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkPreviewImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkPreviewImage_url_key" ON "LinkPreviewImage"("url");

-- CreateIndex
CREATE INDEX "LinkPreviewImage_sourceUrl_createdAt_idx" ON "LinkPreviewImage"("sourceUrl", "createdAt");

-- CreateIndex
CREATE INDEX "LinkPreviewImage_lastUsedAt_idx" ON "LinkPreviewImage"("lastUsedAt");
