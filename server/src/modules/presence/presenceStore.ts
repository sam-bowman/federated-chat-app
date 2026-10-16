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
  // The person's own devices are told too, with their REAL status: invisible is shown to everyone else as
  // offline, but they should see (and not forget) that they are invisible. Without this, a client only knew its
  // own status from when it signed in, so it showed offline while connected, and a change made on another
  // device never showed on this one.
  sendToUsers([userId], { type: "presence:self", status, customStatus });

  const remoteDomains = [...new Set(friendships.filter((f) => f.friend.isRemote).map((f) => f.friend.homeserverDomain))];
  // A private server tells no other server anything, presence included (and does not fill its log with the refusals).
  if (!config.federationEnabled) return;
  for (const domain of remoteDomains) {
    // Nor to one it does not talk to (and no log line for the refusal).
    if (!config.federationPolicy.isPermitted(domain)) continue;
    try {
      await federationFetch(domain, "/presence", {
        body: { username, domain: config.domain, status: visibleStatus, customStatus },
      });
    } catch (err) {
      console.error("[federation] presence push to %s failed:", domain, err);
    }
  }
}
