import { prisma } from "../../db.js";
import { sendToUsers } from "../../ws/gateway.js";

type PresenceStatus = "ONLINE" | "AWAY" | "BUSY" | "DO_NOT_DISTURB" | "INVISIBLE" | "OFFLINE";

export async function setPresenceInMemory(userId: string, status: PresenceStatus) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      presenceStatus: status,
      lastSeenAt: status === "OFFLINE" ? new Date() : undefined,
    },
    select: { id: true, username: true, customStatus: true },
  });

  await broadcastPresence(userId, status, user.customStatus);
}

export async function setCustomStatus(userId: string, customStatus: string | null) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { customStatus },
    select: { presenceStatus: true },
  });
  await broadcastPresence(userId, user.presenceStatus, customStatus);
}

async function broadcastPresence(
  userId: string,
  status: PresenceStatus,
  customStatus: string | null
) {
  const friendships = await prisma.friendship.findMany({
    where: { userId },
    select: { friendId: true },
  });
  // A user who goes INVISIBLE is reported to others as OFFLINE.
  const visibleStatus = status === "INVISIBLE" ? "OFFLINE" : status;
  sendToUsers(
    friendships.map((f) => f.friendId),
    { type: "presence", userId, status: visibleStatus, customStatus }
  );
}
