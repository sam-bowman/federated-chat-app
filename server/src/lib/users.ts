import { prisma } from "../db.js";
import { config } from "../config.js";

/**
 * Username is only unique *within* a homeserver now that remote stubs share
 * the table (@bob could exist on both bob.test and bob.example). Every
 * lookup that means "a real account on THIS server" - login, registration,
 * profile pages, search, bans - must go through this instead of a bare
 * `findUnique({ where: { username } })`, which no longer type-checks since
 * username alone stopped being a unique key.
 */
export function findLocalUserByUsername(username: string) {
  return prisma.user.findFirst({
    where: { username, homeserverDomain: config.domain, isRemote: false },
  });
}
