// Who may join a community (#109, phase 4): one setting a community's managers choose.
//
//   - UNLISTED (the default, and what every community was): anyone who has the community's id can join, on this server or another;
//   - INVITE_ONLY: joining needs an invite (lib/invites.ts), from anywhere;
//   - LOCAL_ONLY: only accounts on the community's own server can join. A person on another server is told the community does
//     not exist (the same answer as for an id nobody has), so it cannot even be confirmed to be there;
//   - PUBLIC: joinable like UNLISTED, and also listed in the server's directory when the server publishes one (DIRECTORY_ENABLED).
//     Where there is no directory it is simply UNLISTED.
//
// This used to be a single yes/no, `openJoin`, which is still sent (derived) for the clients and servers that read it.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

export const COMMUNITY_VISIBILITIES = ["UNLISTED", "INVITE_ONLY", "LOCAL_ONLY", "PUBLIC"] as const;
export type CommunityVisibility = (typeof COMMUNITY_VISIBILITIES)[number];

export function isCommunityVisibility(value: unknown): value is CommunityVisibility {
  return typeof value === "string" && (COMMUNITY_VISIBILITIES as readonly string[]).includes(value);
}

/** Whether a person who holds only the community's id (no invite) may join, if they are allowed in at all. */
export function joinsWithoutInvite(visibility: CommunityVisibility): boolean {
  return visibility !== "INVITE_ONLY";
}

/** Whether people on other servers may join (or be told the community exists). */
export function acceptsOtherServers(visibility: CommunityVisibility): boolean {
  return visibility !== "LOCAL_ONLY";
}

/** The old yes/no, for anything that still reads it: "can anyone with the id join?" (a local-only community is open to all it accepts). */
export function openJoinOf(visibility: CommunityVisibility): boolean {
  return joinsWithoutInvite(visibility);
}

/** What a community with only the old yes/no (an older server's snapshot, or a stored row from before) amounts to. */
export function visibilityFromOpenJoin(openJoin: boolean | undefined): CommunityVisibility {
  return openJoin === false ? "INVITE_ONLY" : "UNLISTED";
}

/**
 * How exposed to other servers each kind is, least to most: local-only is closed to them, invite-only needs an invite, unlisted is
 * open to anyone with the id, public is that and listed. A server's LIMIT (`COMMUNITY_VISIBILITY_LIMIT`) is the most exposed a
 * community may be; a community set wider than it behaves as the limit itself.
 */
const EXPOSURE: readonly CommunityVisibility[] = ["LOCAL_ONLY", "INVITE_ONLY", "UNLISTED", "PUBLIC"];

export function isWiderThan(visibility: CommunityVisibility, limit: CommunityVisibility): boolean {
  return EXPOSURE.indexOf(visibility) > EXPOSURE.indexOf(limit);
}

/** What is in force for a community set to `visibility` on a server whose limit is `limit`: the setting, or the limit if it is wider. */
export function effectiveVisibility(visibility: CommunityVisibility, limit: CommunityVisibility): CommunityVisibility {
  return isWiderThan(visibility, limit) ? limit : visibility;
}

/**
 * Parses a server setting that names a visibility (COMMUNITY_VISIBILITY_DEFAULT / _LIMIT): unset or empty is `fallback`, a name in any
 * case is that visibility, anything else throws naming the variable.
 */
export function parseVisibilitySetting(name: string, raw: string | undefined, fallback: CommunityVisibility): CommunityVisibility {
  const value = (raw ?? "").trim().toUpperCase().replace(/-/g, "_");
  if (value === "") return fallback;
  const visibility = COMMUNITY_VISIBILITIES.find((v) => v === value);
  if (visibility) return visibility;
  throw new Error(`${name} is "${raw}", which is not one of ${COMMUNITY_VISIBILITIES.join(", ")}. A value that could be a typo is refused rather than guessed.`);
}

/** Refuses a default that is wider than the limit: new communities would start somewhere nobody is allowed to be. */
export function checkVisibilityDefault(defaultVisibility: CommunityVisibility, limit: CommunityVisibility): void {
  if (isWiderThan(defaultVisibility, limit)) {
    throw new Error(
      `COMMUNITY_VISIBILITY_DEFAULT is ${defaultVisibility}, which is wider than COMMUNITY_VISIBILITY_LIMIT (${limit}): new communities could not start there. Lower the default or raise the limit.`
    );
  }
}
