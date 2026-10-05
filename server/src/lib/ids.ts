import { ulid } from "ulid";

/**
 * Generates a protocol-level ID (ULID): globally unique, time-sortable, and
 * independent of the local database's auto-increment/UUID primary key.
 * Every federatable object (users, messages, communities, emoticons, sync
 * events, ...) gets one of these in addition to its DB id.
 */
export function newProtocolId(): string {
  return ulid();
}

export function identityFor(username: string, domain: string): string {
  return `@${username}:${domain}`;
}

/**
 * Parses either a full `@user:domain` identity or a bare `user` (which is
 * assumed to mean a user on `defaultDomain`, i.e. this server). Returns null
 * for anything that isn't a plausible username/domain shape.
 */
export function parseIdentity(input: string, defaultDomain: string): { username: string; domain: string } | null {
  const trimmed = input.trim();
  const match = /^@?([a-z0-9_]+)(?::(.+))?$/i.exec(trimmed);
  if (!match) return null;
  const [, username, domain] = match;
  return { username: username.toLowerCase(), domain: (domain ?? defaultDomain).toLowerCase() };
}
