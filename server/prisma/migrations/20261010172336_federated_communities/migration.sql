-- AlterTable: add nullable first so existing rows don't violate NOT NULL,
-- backfill, then tighten the constraint - same pattern as
-- 20261005105346_federation_identity_model's User.homeserverDomain.
ALTER TABLE "Community" ADD COLUMN     "homeserverDomain" TEXT,
ADD COLUMN     "isRemote" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every existing Community row predates federated communities, so
-- it is by definition locally-owned/authoritative on this server's own
-- domain. NOTE for anyone applying this to an already-deployed server: this
-- literal is only correct because config.domain also defaults to
-- "localhost" (server/src/config.ts) - a server that set a real
-- SERVER_DOMAIN before running this migration must hand-edit this literal
-- to match it first, or every pre-existing community will be mis-tagged as
-- owned by the wrong domain.
UPDATE "Community" SET "homeserverDomain" = 'localhost' WHERE "homeserverDomain" IS NULL;

ALTER TABLE "Community" ALTER COLUMN "homeserverDomain" SET NOT NULL;
