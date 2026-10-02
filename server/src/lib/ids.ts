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
