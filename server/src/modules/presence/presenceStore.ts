import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { sendToUsers } from "../../ws/gateway.js";
import { federationFetch } from "../../lib/federation/client.js";

type PresenceStatus = "ONLINE" | "AWAY" | "BUSY" | "DO_NOT_DISTURB" | "INVISIBLE" | "OFFLINE";

export async function setPresenceInMemory(userId: string, status: PresenceStatus) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      presenceStatus: status,
      lastSeenAt: status === "OFFLINE" ? new Date() : undefined,
    },
    select: { id: true, protocolId: true, username: true, customStatus: true },
  });

  await broadcastPresence(user.id, user.protocolId, user.username, status, user.customStatus);
}

export async function setCustomStatus(userId: string, customStatus: string | null) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { customStatus },
    select: { id: true, protocolId: true, username: true, presenceStatus: true },
  });
  await broadcastPresence(user.id, user.protocolId, user.username, user.presenceStatus, customStatus);
}

/**
 * `userId` (local DB id) is used for the Friendship lookup; `userProtocolId`
 * is what actually goes out over the wire, since every client-facing id -
 * including the `userId` field on a "presence" WS event - is a protocolId,
 * never the local DB id a client never sees otherwise.
 */
async function broadcastPresence(
  userId: string,
  userProtocolId: string,
  username: string,
  status: PresenceStatus,
  customStatus: string | null
) {
  const friendships = await prisma.friendship.findMany({
    where: { userId },
    select: { friend: { select: { id: true, isRemote: true, homeserverDomain: true } } },
  });
  // A user who goes INVISIBLE is reported to others as OFFLINE.
  const visibleStatus = status === "INVISIBLE" ? "OFFLINE" : status;

  const localFriendIds = friendships.filter((f) => !f.friend.isRemote).map((f) => f.friend.id);
  sendToUsers(localFriendIds, { type: "presence", userId: userProtocolId, status: visibleStatus, customStatus });

  const remoteDomains = [...new Set(friendships.filter((f) => f.friend.isRemote).map((f) => f.friend.homeserverDomain))];
  for (const domain of remoteDomains) {
    try {
      await federationFetch(domain, "/presence", {
        body: { username, domain: config.domain, status: visibleStatus, customStatus },
      });
    } catch (err) {
      console.error(`[federation] presence push to ${domain} failed:`, err);
    }
  }
}
