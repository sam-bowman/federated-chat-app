import { describe, expect, it, vi } from "vitest";
import { clearOrphanedPresence, resetPresenceAtStartup, type PresenceResetDeps } from "./presenceReset.js";

function fakeDeps(overrides: Partial<PresenceResetDeps> = {}): PresenceResetDeps & {
  markedOffline: string[];
  resetEverything: ReturnType<typeof vi.fn>;
} {
  const markedOffline: string[] = [];
  return {
    redisEnabled: true,
    otherReplicasAlive: async () => true,
    usersWithLiveConnections: async () => new Set(),
    hasLiveConnection: async () => false,
    nonOfflineLocalUserIds: async () => [],
    resetEverything: vi.fn(async () => {}),
    markOffline: async (id: string) => {
      markedOffline.push(id);
    },
    markedOffline,
    ...overrides,
  } as PresenceResetDeps & { markedOffline: string[]; resetEverything: ReturnType<typeof vi.fn> };
}

describe("resetPresenceAtStartup", () => {
  it("resets everything when there is no Redis (a single process: nothing can be connected yet)", async () => {
    const deps = fakeDeps({ redisEnabled: false, otherReplicasAlive: async () => true });

    expect(await resetPresenceAtStartup(deps)).toEqual({ mode: "everything" });
    expect(deps.resetEverything).toHaveBeenCalledOnce();
  });

  it("resets everything when this is the only replica running", async () => {
    const deps = fakeDeps({ otherReplicasAlive: async () => false });

    expect(await resetPresenceAtStartup(deps)).toEqual({ mode: "everything" });
    expect(deps.resetEverything).toHaveBeenCalledOnce();
  });

  // The bug: a replica starting while others serve users wiped everyone, including users
  // connected to the others, who then stayed offline until they reconnected.
  it("leaves users connected to other replicas alone, and clears only those with no connection", async () => {
    const deps = fakeDeps({
      nonOfflineLocalUserIds: async () => ["connected-elsewhere", "orphan"],
      usersWithLiveConnections: async () => new Set(["connected-elsewhere"]),
    });

    expect(await resetPresenceAtStartup(deps)).toEqual({ mode: "orphans", cleared: 1 });
    expect(deps.markedOffline).toEqual(["orphan"]);
    expect(deps.resetEverything).not.toHaveBeenCalled();
  });
});

describe("clearOrphanedPresence", () => {
  it("clears nobody when everyone who is online has a connection", async () => {
    const deps = fakeDeps({
      nonOfflineLocalUserIds: async () => ["a", "b"],
      usersWithLiveConnections: async () => new Set(["a", "b"]),
    });

    expect(await clearOrphanedPresence(deps)).toBe(0);
    expect(deps.markedOffline).toEqual([]);
  });

  // The connection scan is a snapshot; a user who connects after it must not be marked offline.
  it("re-checks a user right before clearing them", async () => {
    const deps = fakeDeps({
      nonOfflineLocalUserIds: async () => ["raced", "gone"],
      hasLiveConnection: async (id) => id === "raced",
    });

    expect(await clearOrphanedPresence(deps)).toBe(1);
    expect(deps.markedOffline).toEqual(["gone"]);
  });

  it("does nothing when nobody is marked online", async () => {
    const deps = fakeDeps();

    expect(await clearOrphanedPresence(deps)).toBe(0);
  });
});
