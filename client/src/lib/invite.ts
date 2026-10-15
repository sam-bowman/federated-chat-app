import type { Community, InviteCard } from "../api";

/**
 * The code that joins a community from any server: its id and the server it lives on,
 * "<id>:<domain>". The id alone only works for someone on the same server (the join endpoint takes
 * a bare id to mean "on this server").
 */
export function inviteCode(community: Pick<Community, "id" | "homeserverDomain">): string {
  return `${community.id}:${community.homeserverDomain}`;
}

/** The same code, from an invitation card. */
export function inviteCardCode(card: Pick<InviteCard, "communityId" | "domain">): string {
  return `${card.communityId}:${card.domain}`;
}

/** Why joining from a card failed, in words the card can show. */
export function joinFailureMessage(status: number | undefined, code: string | undefined, domain: string): string {
  if (status === 403 && code === "banned") return "You can't join this community.";
  if (status === 404) return "This community doesn't exist any more.";
  if (status === 502 || status === 503 || status === 504 || code === "federation_unreachable") {
    return `Couldn't reach ${domain}. Try again later.`;
  }
  return "Couldn't join. Try again.";
}
