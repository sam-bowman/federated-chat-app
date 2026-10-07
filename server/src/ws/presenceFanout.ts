import { randomUUID } from "node:crypto";
import { getRedisClients } from "../lib/redis.js";

const FANOUT_CHANNEL = "ws:fanout";
const CONN_KEY_PREFIX = "ws:conn:";
// 3x the gateway's heartbeat interval (30s) - refreshed on every heartbeat
// tick for a live connection, so this only ever expires on its own if the
// replica holding it stops refreshing entirely (crashed, killed, network
// partition), not from an ordinary missed tick or two.
const CONN_TTL_SECONDS = 90;

export function newConnectionId(): string {
  return randomUUID();
}

function connKey(userId: string, connId: string): string {
  return `${CONN_KEY_PREFIX}${userId}:${connId}`;
}

export function isRedisEnabled(): boolean {
  return getRedisClients() !== null;
}

/**
 * Fleet-wide count of this user's live WebSocket connections, across every
 * replica - not just this process. Always 0 when Redis isn't configured;
 * callers that care about the single-replica case should check
 * isRedisEnabled() themselves and fall back to local state instead of
 * trusting this to mean "offline".
 */
export async function countFleetConnections(userId: string): Promise<number> {
  const redis = getRedisClients();
  if (!redis) return 0;

  const pattern = `${connKey(userId, "*")}`;
  let cursor = "0";
  let count = 0;
  do {
    const [next, keys] = await redis.pub.scan(cursor, "MATCH", pattern, "COUNT", 100);
    count += keys.length;
    cursor = next;
  } while (cursor !== "0");
  return count;
}

/** Marks (or refreshes) one connection as alive. No-op without Redis. */
export async function markConnectionAlive(userId: string, connId: string): Promise<void> {
  const redis = getRedisClients();
  if (!redis) return;
  await redis.pub.set(connKey(userId, connId), "1", "EX", CONN_TTL_SECONDS);
}

/** Marks one connection as gone (clean close). No-op without Redis. */
export async function markConnectionGone(userId: string, connId: string): Promise<void> {
  const redis = getRedisClients();
  if (!redis) return;
  await redis.pub.del(connKey(userId, connId));
}

/**
 * Publishes an event for fan-out to every replica (including this one, via
 * its own subscription - see subscribeFanout). Returns false (and publishes
 * nothing) when Redis isn't configured, so callers know to deliver locally
 * themselves instead.
 */
export async function publishFanout(userIds: string[], event: unknown): Promise<boolean> {
  const redis = getRedisClients();
  if (!redis) return false;
  await redis.pub.publish(FANOUT_CHANNEL, JSON.stringify({ userIds: [...new Set(userIds)], event }));
  return true;
}

/** Subscribes to fan-out events from every replica, including this one. No-op without Redis. */
export function subscribeFanout(onMessage: (userIds: string[], event: unknown) => void): void {
  const redis = getRedisClients();
  if (!redis) return;

  redis.sub.on("message", (channel: string, message: string) => {
    if (channel !== FANOUT_CHANNEL) return;
    try {
      const parsed = JSON.parse(message) as { userIds: string[]; event: unknown };
      onMessage(parsed.userIds, parsed.event);
    } catch (err) {
      console.error("[redis] malformed fanout message:", err);
    }
  });

  redis.sub
    .subscribe(FANOUT_CHANNEL)
    .catch((err: Error) => console.error("[redis] failed to subscribe to fanout channel:", err));
}
