import type { Community, Invite, InviteCard, InviteStatus } from "../api";

/**
 * The permanent code that joins a community from any server: its id and the server it lives on,
 * "<id>:<domain>". The id alone only works for someone on the same server (the join endpoint takes
 * a bare id to mean "on this server"). It works only while the community lets anyone join.
 */
export function inviteCode(community: Pick<Community, "id" | "homeserverDomain">): string {
  return `${community.id}:${community.homeserverDomain}`;
}

/** The same thing from an invitation card: with the card's own invite after a "#" when it has one. */
export function inviteCardCode(card: Pick<InviteCard, "communityId" | "domain" | "code">): string {
  return `${card.communityId}:${card.domain}${card.code ? `#${card.code}` : ""}`;
}

/** Whether a community lets anyone with its id join. A server that predates invites does not say, and it did. */
export function isOpenToAnyone(community: Pick<Community, "openJoin">): boolean {
  return community.openJoin !== false;
}

// The server is private: nothing to do with another server can be done from it, whatever the invitation says.
const PRIVATE_SERVER = "This server doesn't connect to other servers, so you can't join a community on one.";

// The errors a join answers with when the invite itself is the problem. Retrying cannot help with any of them.
const INVITE_PROBLEMS: Record<string, string> = {
  invite_expired: "This invitation has expired. Ask for a new one.",
  invite_revoked: "This invitation was cancelled. Ask for a new one.",
  invite_used_up: "This invitation has already been used. Ask for a new one.",
  invite_invalid: "This invitation isn't valid.",
  invite_required: "This community is invite-only. Ask a member to invite you.",
};

/** True for a join that failed because of the invitation, which no amount of trying again will fix. */
export function isInviteProblem(code: string | undefined): boolean {
  return code !== undefined && Object.prototype.hasOwnProperty.call(INVITE_PROBLEMS, code);
}

/** Why joining failed, in words the card (or the Join by ID box) can show. */
export function joinFailureMessage(status: number | undefined, code: string | undefined, domain: string): string {
  if (code === "federation_disabled") return PRIVATE_SERVER;
  if (isInviteProblem(code)) return INVITE_PROBLEMS[code as string];
  if (status === 403 && code === "banned") return "You can't join this community.";
  if (status === 404) return "This community doesn't exist any more.";
  if (status === 502 || status === 503 || status === 504 || code === "federation_unreachable") {
    return `Couldn't reach ${domain}. Try again later.`;
  }
  return "Couldn't join. Try again.";
}

/** The server part of something pasted into Join by ID ("<id>:<server>#<code>"), or null if it names none. */
export function referenceDomain(reference: string): string | null {
  const withoutCode = reference.trim().split("#")[0];
  const colon = withoutCode.indexOf(":");
  const domain = colon === -1 ? "" : withoutCode.slice(colon + 1).trim();
  return domain === "" ? null : domain;
}

/**
 * Why Join by ID failed. A problem with the invitation, a ban or an unreachable server is explained as on a card; anything
 * else (a mistyped id, a community that is not there) is the box's own "couldn't find it".
 */
export function joinByIdFailureMessage(status: number | undefined, code: string | undefined, reference: string): string {
  const unreachable = status === 502 || status === 503 || status === 504 || code === "federation_unreachable";
  if (isInviteProblem(code) || code === "federation_disabled" || (status === 403 && code === "banned") || unreachable) {
    return joinFailureMessage(status, code, referenceDomain(reference) ?? "that server");
  }
  return "Couldn't find or join that community.";
}

// --- Making and showing invites ---

/** How long an invite lasts, as offered when making one. The seconds are what the server accepts, and nothing else. */
export const INVITE_EXPIRY_CHOICES: { value: number | null; label: string }[] = [
  { value: 3600, label: "1 hour" },
  { value: 86_400, label: "24 hours" },
  { value: 604_800, label: "7 days" },
  { value: null, label: "Never" },
];

/** How many people may join with an invite. The server accepts any whole number from 1 to 1000. */
export const INVITE_USE_CHOICES: { value: number | null; label: string }[] = [
  { value: null, label: "No limit" },
  { value: 1, label: "1 use" },
  { value: 5, label: "5 uses" },
  { value: 10, label: "10 uses" },
  { value: 25, label: "25 uses" },
  { value: 50, label: "50 uses" },
  { value: 100, label: "100 uses" },
];

export const INVITE_STATUS_LABELS: Record<InviteStatus, string> = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  used_up: "Used up",
};

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "Never expires", "Expires in 3 hours", or "Expired". Rounded up to the unit in use, so it never says "0 minutes". */
export function inviteExpiryText(expiresAt: string | null, now: Date = new Date()): string {
  if (expiresAt === null) return "Never expires";
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(ms)) return "Never expires";
  if (ms <= 0) return "Expired";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `Expires in ${plural(minutes, "minute")}`;
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 48) return `Expires in ${plural(hours, "hour")}`;
  return `Expires in ${plural(Math.ceil(ms / 86_400_000), "day")}`;
}

/** "2 of 5 used", or "2 uses" when there is no limit. */
export function inviteUsesText(invite: Pick<Invite, "uses" | "maxUses">): string {
  return invite.maxUses === null ? plural(invite.uses, "use") : `${invite.uses} of ${invite.maxUses} used`;
}

/** What an invite allows, for one just made: "Any number of people", "One person", "5 people". */
export function inviteLimitText(maxUses: number | null): string {
  return maxUses === null ? "Any number of people" : maxUses === 1 ? "One person" : `${maxUses} people`;
}
