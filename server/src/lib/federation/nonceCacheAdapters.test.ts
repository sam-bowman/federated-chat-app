import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryNonceCache, RedisNonceCache } from "./nonceCacheAdapters.js";

describe("InMemoryNonceCache", () => {
  it("returns true the first time a key is seen", async () => {
    const cache = new InMemoryNonceCache();
    expect(await cache.checkAndRecord("sig-a", 60000)).toBe(true);
  });

  it("returns false for a key seen again within its TTL - a replay", async () => {
    const cache = new InMemoryNonceCache();
    expect(await cache.checkAndRecord("sig-a", 60000)).toBe(true);
    expect(await cache.checkAndRecord("sig-a", 60000)).toBe(false);
  });

  it("treats different keys independently", async () => {
    const cache = new InMemoryNonceCache();
    expect(await cache.checkAndRecord("sig-a", 60000)).toBe(true);
    expect(await cache.checkAndRecord("sig-b", 60000)).toBe(true);
  });

  it("allows a key again once its TTL has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const cache = new InMemoryNonceCache();
      expect(await cache.checkAndRecord("sig-a", 1000)).toBe(true);
      expect(await cache.checkAndRecord("sig-a", 1000)).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(await cache.checkAndRecord("sig-a", 1000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RedisNonceCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when the underlying SET NX succeeds (key was new)", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    const cache = new RedisNonceCache({ set } as never);
    expect(await cache.checkAndRecord("sig-a", 60000)).toBe(true);
    expect(set).toHaveBeenCalledWith("nonce:sig-a", "1", "PX", 60000, "NX");
  });

  it("returns false when the underlying SET NX is refused (key already existed - a replay)", async () => {
    const set = vi.fn().mockResolvedValue(null);
    const cache = new RedisNonceCache({ set } as never);
    expect(await cache.checkAndRecord("sig-a", 60000)).toBe(false);
  });
});
