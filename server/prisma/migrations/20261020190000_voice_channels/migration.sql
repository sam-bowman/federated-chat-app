-- A channel can be a voice channel: people join it and talk, and it has no messages.
ALTER TYPE "ChannelType" ADD VALUE 'VOICE';

-- CONNECT_VOICE is permission bit 10 (1024). Everyone can join a voice channel unless a manager takes it away, so every
-- community's @everyone role gets it (the bit is written by value, like CREATE_INVITE's: do not renumber it).
UPDATE "Role" SET "permissions" = "permissions" | 1024 WHERE "isDefault" = true;
