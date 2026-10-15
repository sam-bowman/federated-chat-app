-- A person can add pronouns and an accent colour to their profile. NULL means not set.
ALTER TABLE "User" ADD COLUMN "pronouns" TEXT;
ALTER TABLE "User" ADD COLUMN "accentColor" TEXT;
