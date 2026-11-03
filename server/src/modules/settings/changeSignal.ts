import { randomUUID } from "node:crypto";
import { getRedisClients } from "../../lib/redis.js";

// Tells the other replicas that a setting was just stored or reset, so they read the table now instead of at the next timer tick
// (modules/settings/service.ts). The message carries only the sender's id (never a value: the table is the one truth, and a replica reads it) and
// it is a HINT: Redis pub/sub does not queue for a replica that is reconnecting, so the timer stays as the fallback and a lost message costs at
// most one interval. Without REDIS_URL there is nothing to tell (and a single replica never needs it).
const CHANNEL = "settings:changed";

// Who sent it, so a replica does not read the table again for its own change (it applied it already).
const REPLICA_ID = randomUUID();

/** Says a setting changed. Never throws: the change is stored, and the other replicas still catch up on the timer. */
export async function announceSettingsChange(): Promise<void> {
  const redis = getRedisClients();
  if (!redis) return;
  try {
    await redis.pub.publish(CHANNEL, REPLICA_ID);
  } catch (err) {
    console.error("[settings] could not tell the other replicas about a change:", err);
  }
}

/** Calls `onChange` when ANOTHER replica announces a change. Returns what stops listening. A no-op without Redis. */
export function onSettingsChangedElsewhere(onChange: () => void): () => void {
  const redis = getRedisClients();
  if (!redis) return () => {};

  const listener = (channel: string, message: string) => {
    if (channel === CHANNEL && message !== REPLICA_ID) onChange();
  };
  redis.sub.on("message", listener);
  redis.sub.subscribe(CHANNEL).catch((err: Error) => console.error("[settings] could not listen for changes from the other replicas:", err));

  return () => {
    redis.sub.off("message", listener);
    redis.sub.unsubscribe(CHANNEL).catch(() => {});
  };
}
