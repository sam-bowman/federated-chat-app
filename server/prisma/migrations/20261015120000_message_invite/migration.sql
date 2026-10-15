-- A direct invitation to a community, carried by a direct message: {communityId, domain, name}.
-- NULL for every ordinary message. Validated by src/lib/invite.ts on the way in and out.
ALTER TABLE "Message" ADD COLUMN "invite" JSONB;
