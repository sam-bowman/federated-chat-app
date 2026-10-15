import { z } from "zod";

/**
 * A direct invitation to a community, carried by a direct message (`Message.invite`) and shown by
 * the client as a card with a Join button. It is data, never markup: the client renders the name as
 * text.
 *
 * It holds just enough to show the card and to join: which community (`communityId` is its
 * protocolId, `domain` the server it lives on, so it works from any server), and its name as it was
 * when the invite was sent (a server that never heard of the community has nothing else to show).
 * The sending server fills it in from its own records; it never copies a name from the request.
 */
export const inviteCardSchema = z.object({
  // A protocolId: what parseCommunityReference accepts before the colon.
  communityId: z.string().regex(/^[0-9A-Za-z]+$/).max(64),
  // A host, lower case, with an optional port (as every federation domain is).
  domain: z.string().regex(/^[a-z0-9.-]+(:\d{1,5})?$/).max(253),
  name: z.string().min(1).max(100),
});

export type InviteCard = z.infer<typeof inviteCardSchema>;

/**
 * An invite from stored or received data, or null when there is none or it is not a well-formed
 * one. Used on the way out as well as in: whatever is in the column, a malformed value is shown as an
 * ordinary message instead of breaking the page, and unknown fields are dropped.
 */
export function parseInvite(value: unknown): InviteCard | null {
  const parsed = inviteCardSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What a community is called when you join it: "<protocolId>:<domain>", the same thing as the invite code. */
export function inviteReference(card: Pick<InviteCard, "communityId" | "domain">): string {
  return `${card.communityId}:${card.domain}`;
}

/**
 * The text of an invite message, for anything that shows messages as text (the conversation list's
 * last message, a client that does not know cards) and so that the code is there to copy.
 */
export function inviteFallbackText(card: InviteCard): string {
  return `Invited you to join ${card.name} (join code: ${inviteReference(card)})`;
}
