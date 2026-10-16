-- A reaction can now be a custom emoticon as well as a Unicode emoji (#110).
--
-- `emoji` becomes optional, and a reaction to an emoticon names it by `emoticonProtocolId` (its id on the
-- server that owns it). `emoticonId` links the emoticon when it is one of this server's own rows, so deleting
-- the emoticon takes its reactions with it; one on another server has no row here, so its name and picture
-- are kept in `emoticonName` / `emoticonImageUrl` instead.

ALTER TABLE "Reaction" ALTER COLUMN "emoji" DROP NOT NULL;
ALTER TABLE "Reaction" ADD COLUMN "emoticonProtocolId" TEXT;
ALTER TABLE "Reaction" ADD COLUMN "emoticonId" TEXT;
ALTER TABLE "Reaction" ADD COLUMN "emoticonName" TEXT;
ALTER TABLE "Reaction" ADD COLUMN "emoticonImageUrl" TEXT;

ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_emoticonId_fkey"
  FOREIGN KEY ("emoticonId") REFERENCES "Emoticon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NULLs are distinct in a Postgres unique index, so the existing (messageId, userId, emoji) index does not
-- constrain emoticon reactions: they get their own.
CREATE UNIQUE INDEX "Reaction_messageId_userId_emoticonProtocolId_key" ON "Reaction"("messageId", "userId", "emoticonProtocolId");

-- Exactly one kind. (Prisma cannot express a CHECK, so the schema does not mention it.)
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_exactly_one_kind"
  CHECK (("emoji" IS NOT NULL) <> ("emoticonProtocolId" IS NOT NULL));
