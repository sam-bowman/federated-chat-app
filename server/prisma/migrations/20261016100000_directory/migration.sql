-- The directory (#109 phase 5): a community can be PUBLIC (joinable like UNLISTED, and listed if the server publishes a
-- directory), and a person can choose to be listed. Nobody is listed until they, or a community's managers, choose.
ALTER TYPE "CommunityVisibility" ADD VALUE 'PUBLIC';
ALTER TABLE "User" ADD COLUMN "listedInDirectory" BOOLEAN NOT NULL DEFAULT false;
