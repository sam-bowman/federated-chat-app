import type { User } from "@prisma/client";
import { config } from "../config.js";
import { identityFor } from "./ids.js";

export function publicUser(user: User) {
  return {
    id: user.protocolId,
    identity: identityFor(user.username, config.domain),
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    presence: {
      status: user.presenceStatus,
      customStatus: user.customStatus,
      lastSeenAt: user.lastSeenAt,
    },
  };
}

export type PublicUser = ReturnType<typeof publicUser>;
