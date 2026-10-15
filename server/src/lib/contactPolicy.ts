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
