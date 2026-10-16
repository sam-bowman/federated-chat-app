// Who may join a community (#109, phase 4): the three choices a manager has, in the words Settings uses, and how a community's
// own record is read. The server decides (lib/communityVisibility.ts there); nothing here is a check.
import type { Community } from "../api";

export type CommunityVisibility = "UNLISTED" | "INVITE_ONLY" | "LOCAL_ONLY" | "PUBLIC";

export const VISIBILITY_CHOICES: { value: CommunityVisibility; label: string; description: string }[] = [
  {
    value: "UNLISTED",
    label: "Anyone with the community code",
    description: "Anyone who has the code can join, on this server or another. This is how every community started.",
  },
  {
    value: "PUBLIC",
    label: "Public: listed in the directory",
    description:
      "Anyone with the code can join, as above, and the community is also listed in this server's directory for people to browse and join, if the server publishes one.",
  },
  {
    value: "INVITE_ONLY",
    label: "Only people with an invite",
    description: "People need an invite from a member; the community code no longer lets anyone in.",
  },
  {
    value: "LOCAL_ONLY",
    label: "Only people on this server",
    description:
      "Anyone on this server can join with the code. People on other servers can't, and are told there is no such community. Anyone from another server who is already in stays.",
  },
];

/**
 * How exposed to other servers each kind is, least to most: closed to them, invite needed, open to anyone with the id, listed. The
 * server's limit is the most exposed a community may be (server/src/lib/communityVisibility.ts keeps the same order).
 */
const EXPOSURE: CommunityVisibility[] = ["LOCAL_ONLY", "INVITE_ONLY", "UNLISTED", "PUBLIC"];

/** Whether choosing `choice` is wider than the server lets a community be (a server that sends no limit has none). */
export function isWiderThanLimit(choice: CommunityVisibility, limit: CommunityVisibility | undefined): boolean {
  return limit !== undefined && EXPOSURE.indexOf(choice) > EXPOSURE.indexOf(limit);
}

/**
 * A community's setting. A server that predates it sends only the old yes/no (`openJoin`), and one that predates both said
 * nothing, which meant anyone could join.
 */
export function visibilityOf(community: Pick<Community, "visibility" | "openJoin">): CommunityVisibility {
  if (community.visibility) return community.visibility;
  return community.openJoin === false ? "INVITE_ONLY" : "UNLISTED";
}

/** Whether the community only takes people from its own server. */
export function isLocalOnly(community: Pick<Community, "visibility" | "openJoin">): boolean {
  return visibilityOf(community) === "LOCAL_ONLY";
}
