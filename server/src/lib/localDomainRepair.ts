import type { PrismaClient } from "../generated/prisma/client.js";

// Two migrations (20261005105346_federation_identity_model, v0.2.0, for users;
// 20261010172336_federated_communities, v0.8.0, for communities) added a
// `homeserverDomain` column and backfilled every existing local row with the literal
// string 'localhost': a migration's SQL cannot see SERVER_DOMAIN. A server that runs
// on a real domain is left with local rows tagged with a domain that is not its own.
//
// For users that is not cosmetic. Login, search, friend lookups and federation all
// find a local account by `homeserverDomain = SERVER_DOMAIN` (lib/users.ts), so such
// an account cannot log in (401), cannot be found, and its username can be registered
// a second time. Communities carry the same stale value, but nothing reads it for a
// local community; it is repaired for consistency, and because the owner's domain
// travels with a community to peers.
//
// This runs once per start, after the migrations, and is idempotent. Takes the Prisma
// client and the domain as arguments, like the other src/lib helpers, so it never
// imports config.ts.

const STALE_DOMAIN = "localhost";

export interface LocalDomainRepairResult {
  users: number;
  communities: number;
  /** Usernames left tagged 'localhost' because an account with that name already exists on the real domain. */
  conflicts: string[];
}

export async function repairLocalHomeserverDomains(
  prisma: Pick<PrismaClient, "$executeRaw" | "$queryRaw">,
  serverDomain: string
): Promise<LocalDomainRepairResult> {
  // A server that really is called localhost (local development) has nothing to repair.
  if (serverDomain.toLowerCase() === STALE_DOMAIN) return { users: 0, communities: 0, conflicts: [] };

  // Skips - rather than fails on - a user whose username is already taken on the real
  // domain (someone locked out by this very problem may have registered again): the
  // unique key is (username, homeserverDomain), and one such row would otherwise abort
  // startup. Those are reported for a human to resolve.
  const users = await prisma.$executeRaw`
    UPDATE "User" AS u
    SET "homeserverDomain" = ${serverDomain}
    WHERE u."isRemote" = false
      AND u."homeserverDomain" = ${STALE_DOMAIN}
      AND NOT EXISTS (
        SELECT 1 FROM "User" AS other
        WHERE other."username" = u."username" AND other."homeserverDomain" = ${serverDomain}
      )`;

  const communities = await prisma.$executeRaw`
    UPDATE "Community"
    SET "homeserverDomain" = ${serverDomain}
    WHERE "isRemote" = false AND "homeserverDomain" = ${STALE_DOMAIN}`;

  const leftovers = await prisma.$queryRaw<{ username: string }[]>`
    SELECT "username" FROM "User"
    WHERE "isRemote" = false AND "homeserverDomain" = ${STALE_DOMAIN}
    ORDER BY "username"`;

  return { users, communities, conflicts: leftovers.map((row) => row.username) };
}

/** The log lines for a result, or an empty list when there was nothing to say. */
export function describeRepair(result: LocalDomainRepairResult, serverDomain: string): string[] {
  const lines: string[] = [];
  if (result.users > 0 || result.communities > 0) {
    lines.push(
      `Repaired ${result.users} local account(s) and ${result.communities} communit(ies) that an old migration had tagged ` +
        `'${STALE_DOMAIN}': they now belong to ${serverDomain}.`
    );
  }
  if (result.conflicts.length > 0) {
    lines.push(
      `WARNING: ${result.conflicts.length} local account(s) are still tagged '${STALE_DOMAIN}' and cannot log in, because an account ` +
        `with the same username already exists on ${serverDomain}: ${result.conflicts.join(", ")}. Rename or remove one of each ` +
        "pair in the database, then restart. See docs/deployment/upgrading-and-backups.md."
    );
  }
  return lines;
}
