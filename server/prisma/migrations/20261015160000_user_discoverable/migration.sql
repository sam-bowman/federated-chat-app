-- Whether servers with no relationship to a person may find them by handle (#109 phase 3). Everyone starts findable, as before.
ALTER TABLE "User" ADD COLUMN "discoverable" BOOLEAN NOT NULL DEFAULT true;
