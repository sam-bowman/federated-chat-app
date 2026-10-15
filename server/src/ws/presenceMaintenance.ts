import { prisma } from "../db.js";
import { clearOrphanedPresence, resetPresenceAtStartup, type PresenceResetDeps } from "../lib/presenceReset.js";
import { setPresenceInMemory } from "../modules/presence/presenceStore.js";
import {
  countFleetConnections,
  isRedisEnabled,
  liveConnectionUserIds,
  markReplicaAlive,
  markReplicaGone,
  newConnectionId,
  otherReplicasAlive,
} from "./presenceFanout.js";

// Refresh well inside the key's 90 s lifetime, like the connection keys do.
const REPLICA_REFRESH_MS = 30_000;
const SWEEP_MS = 60_000;

const replicaId = newConnectionId();

const deps: PresenceResetDeps = {
  get redisEnabled() {
    return isRedisEnabled();
  },
  otherReplicasAlive: () => otherReplicasAlive(replicaId),
  usersWithLiveConnections: liveConnectionUserIds,
  hasLiveConnection: async (userId) => (await countFleetConnections(userId)) > 0,
  nonOfflineLocalUserIds: async () =>
    (
      await prisma.user.findMany({
        where: { isRemote: false, presenceStatus: { not: "OFFLINE" } },
        select: { id: true },
      })
    ).map((u) => u.id),
  resetEverything: async () => {
    await prisma.user.updateMany({
      where: { presenceStatus: { not: "OFFLINE" } },
      data: { presenceStatus: "OFFLINE", lastSeenAt: new Date() },
    });
  },
  markOffline: (userId) => setPresenceInMemory(userId, "OFFLINE"),
};

/**
 * Called once at startup, before listening. Registers this replica (first, so two replicas that
 * start together see each other and neither wipes the other's users), then clears whatever
 * stored presence the previous process left behind. Returns a function that stops the timers
 * and unregisters the replica, for a graceful shutdown.
 */
export async function startPresenceMaintenance(): Promise<() => Promise<void>> {
  if (isRedisEnabled()) await markReplicaAlive(replicaId);

  // There are, by definition, zero live WebSocket connections on this process the instant it
  // starts, so any presence left from before (dev reload, deploy, crash) is stale and would
  // never self-correct: nothing is left to close or fail a heartbeat. Reconnecting clients flip
  // themselves back to ONLINE within seconds. What counts as "stale" differs once several
  // replicas share users - see lib/presenceReset.ts.
  const outcome = await resetPresenceAtStartup(deps);
  if (outcome.mode === "orphans" && outcome.cleared > 0) {
    console.log(`[presence] cleared ${outcome.cleared} user(s) left online by a replica that stopped`);
  }

  if (!isRedisEnabled()) return async () => {};

  const refresh = setInterval(() => {
    markReplicaAlive(replicaId).catch((err) => console.error("[presence] failed to refresh replica key:", err));
  }, REPLICA_REFRESH_MS);
  const sweep = setInterval(() => {
    clearOrphanedPresence(deps).catch((err) => console.error("[presence] orphan sweep failed:", err));
  }, SWEEP_MS);
  refresh.unref();
  sweep.unref();

  return async () => {
    clearInterval(refresh);
    clearInterval(sweep);
    await markReplicaGone(replicaId).catch(() => {});
  };
}
