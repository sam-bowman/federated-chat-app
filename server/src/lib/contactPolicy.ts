// Who may start something with a person (#109, phase 3): send them a friend request, or put them in a conversation. A person
// chooses one of three, and (separately from being findable, see lib/userDiscoverability.ts) it applies to people who can find them:
//
//   - ANYONE (the default): anyone;
//   - SHARED_COMMUNITY: only people who share a community with them, on this server or another;
//   - LOCAL_ONLY: only people on this server.
//
// Whoever is already their friend is always allowed, whatever they chose: the setting is about who may START something, and a
// friend has been let in. It never touches a conversation or friendship that already exists.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

export const CONTACT_POLICIES = ["ANYONE", "SHARED_COMMUNITY", "LOCAL_ONLY"] as const;
export type ContactPolicy = (typeof CONTACT_POLICIES)[number];

export function isContactPolicy(value: unknown): value is ContactPolicy {
  return typeof value === "string" && (CONTACT_POLICIES as readonly string[]).includes(value);
}

/** What is known about the person who wants to start something, from the point of view of the person they would contact. */
export interface ContactFacts {
  /** The sender is on the recipient's own server. */
  senderIsLocal: boolean;
  /** The sender is already the recipient's friend. */
  isFriend: boolean;
  /** The sender and the recipient are both members of a community (any server's). */
  sharesCommunity: boolean;
}

/** Whether a person with this setting accepts a friend request or conversation from someone with these facts. */
export function contactAllowed(policy: ContactPolicy, facts: ContactFacts): boolean {
  if (facts.isFriend) return true;
  switch (policy) {
    case "ANYONE":
      return true;
    case "SHARED_COMMUNITY":
      return facts.sharesCommunity;
    case "LOCAL_ONLY":
      return facts.senderIsLocal;
  }
}

/**
 * Whether someone is let in when the server has a LIMIT on top of the person's own choice (`FEDERATION_CONTACT_POLICY_LIMIT`): both must
 * allow it, so the server can only narrow what a person chose, never widen it, and a friend is let in whatever either says. The limit
 * "ANYONE" is no limit at all.
 */
export function contactAllowedUnderLimit(person: ContactPolicy, limit: ContactPolicy, facts: ContactFacts): boolean {
  return contactAllowed(person, facts) && contactAllowed(limit, facts);
}

/** Whether deciding needs to know about shared communities, which costs questions to other servers, so it is not asked for nothing. */
export function needsSharedCommunity(person: ContactPolicy, limit: ContactPolicy): boolean {
  return person === "SHARED_COMMUNITY" || limit === "SHARED_COMMUNITY";
}

/**
 * Parses a server setting that names one of the policies (FEDERATION_CONTACT_POLICY_DEFAULT / _LIMIT): unset or empty is `fallback`, a
 * name in any case is that policy, anything else throws naming the variable. Strict like the other settings: a typo that is guessed
 * could leave a limit that is not the one the operator wrote.
 */
export function parseContactPolicySetting(name: string, raw: string | undefined, fallback: ContactPolicy): ContactPolicy {
  const value = (raw ?? "").trim().toUpperCase().replace(/-/g, "_");
  if (value === "") return fallback;
  const policy = CONTACT_POLICIES.find((p) => p === value);
  if (policy) return policy;
  throw new Error(`${name} is "${raw}", which is not one of ${CONTACT_POLICIES.join(", ")}. A value that could be a typo is refused rather than guessed.`);
}
