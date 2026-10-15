/**
 * Clearing stored presence that no longer matches reality, written so it can be unit tested:
 * everything it needs from the database and Redis comes in through `PresenceResetDeps`
 * (see ws/presenceMaintenance.ts for the real ones).
 *
 * Presence lives in the database (`User.presenceStatus`) but is *caused* by live sockets,
 * which die with the process holding them. So stored presence can be left stale by a restart
 * or a crash, and something has to clear it. With one process that is simple: at startup
 * there are no sockets anywhere, so everything not OFFLINE is stale. With several replicas
 * sharing Redis it is not: a replica that starts while others are serving users must not
 * touch users connected to those others (reproduced: restarting one replica showed every user
 * connected to the other as offline, until they reconnected).
 *
 * The truth for "is this user connected anywhere" is Redis's per-connection keys
 * (ws/presenceFanout.ts), so with Redis only users with no live connection are cleared.
 */

export interface PresenceResetDeps {
  /** True when presence is shared between replicas through Redis. */
  redisEnabled: boolean;
  /** Whether any replica other than this one is running right now. */
  otherReplicasAlive(): Promise<boolean>;
  /** Users (local accounts) that have a live connection on any replica. */
  usersWithLiveConnections(): Promise<Set<string>>;
  /** Whether this one user has a live connection on any replica, checked just before clearing. */
  hasLiveConnection(userId: string): Promise<boolean>;
  /** Local accounts whose stored presence is not OFFLINE. */
  nonOfflineLocalUserIds(): Promise<string[]>;
  /** Sets EVERY account (local and remote) that is not OFFLINE to OFFLINE, without telling anyone. */
  resetEverything(): Promise<void>;
  /** Sets one user OFFLINE and tells their friends. */
  markOffline(userId: string): Promise<void>;
}

export type StartupResetOutcome = { mode: "everything" } | { mode: "orphans"; cleared: number };

/**
 * Clears stored presence that is stale at the moment this process starts.
 *
 * Alone (no Redis, or no other replica running): nothing can be connected, so everything not
 * OFFLINE is reset, exactly as a single-process server always did, remote users included.
 * With other replicas running: only local users with no live connection anywhere.
 */
export async function resetPresenceAtStartup(deps: PresenceResetDeps): Promise<StartupResetOutcome> {
  if (!deps.redisEnabled || !(await deps.otherReplicasAlive())) {
    await deps.resetEverything();
    return { mode: "everything" };
  }
  return { mode: "orphans", cleared: await clearOrphanedPresence(deps) };
}

/**
 * Sets OFFLINE every local user whose stored presence says they are here but who has no live
 * connection on any replica: left behind by a replica that crashed (its connection keys
 * expire on their own) or by a restart that raced a reconnect. Run periodically with Redis.
 * Returns how many were cleared.
 */
export async function clearOrphanedPresence(deps: PresenceResetDeps): Promise<number> {
  const [candidates, live] = await Promise.all([deps.nonOfflineLocalUserIds(), deps.usersWithLiveConnections()]);
  let cleared = 0;
  for (const userId of candidates) {
    if (live.has(userId)) continue;
    // The scan above is a snapshot: the user may have connected since. Looking again for just
    // this user keeps a connect that lands mid-sweep from being marked offline.
    if (await deps.hasLiveConnection(userId)) continue;
    await deps.markOffline(userId);
    cleared++;
  }
  return cleared;
}
