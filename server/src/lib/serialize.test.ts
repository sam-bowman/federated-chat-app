import type { User } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { publicUser } from "./serialize.js";

function baseUser(overrides: Partial<User> = {}): User {
  return {
    id: "db-uuid-1",
    protocolId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    username: "alice",
    passwordHash: "hashed",
    displayName: "Alice",
    avatarUrl: null,
    bio: null,
    homeserverDomain: "alice.test",
    isRemote: false,
    homeserverBaseUrl: null,
    presenceStatus: "ONLINE",
    customStatus: null,
    lastSeenAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as User;
}

describe("publicUser", () => {
  it("never exposes the local database id - only protocolId", () => {
    const result = publicUser(baseUser());
    expect(result.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(JSON.stringify(result)).not.toContain("db-uuid-1");
  });

  it("formats identity as @username:homeserverDomain", () => {
    const result = publicUser(baseUser({ username: "bob", homeserverDomain: "bob.test" }));
    expect(result.identity).toBe("@bob:bob.test");
  });

  it("leaves a local user's relative avatar URL untouched", () => {
    const result = publicUser(baseUser({ isRemote: false, avatarUrl: "/uploads/avatar.png" }));
    expect(result.avatarUrl).toBe("/uploads/avatar.png");
  });

  it("makes a remote user's relative avatar URL absolute against their homeserver", () => {
    const result = publicUser(
      baseUser({ isRemote: true, homeserverBaseUrl: "http://localhost:4001", avatarUrl: "/uploads/avatar.png" })
    );
    expect(result.avatarUrl).toBe("http://localhost:4001/uploads/avatar.png");
  });

  it("leaves an already-absolute remote avatar URL untouched", () => {
    const result = publicUser(
      baseUser({
        isRemote: true,
        homeserverBaseUrl: "http://localhost:4001",
        avatarUrl: "https://cdn.example.com/avatar.png",
      })
    );
    expect(result.avatarUrl).toBe("https://cdn.example.com/avatar.png");
  });

  it("returns null avatarUrl untouched regardless of remote status", () => {
    const result = publicUser(baseUser({ isRemote: true, homeserverBaseUrl: "http://localhost:4001", avatarUrl: null }));
    expect(result.avatarUrl).toBeNull();
  });

  it("includes presence status, custom status, and last seen", () => {
    const result = publicUser(baseUser({ presenceStatus: "BUSY", customStatus: "in a meeting" }));
    expect(result.presence).toEqual({ status: "BUSY", customStatus: "in a meeting", lastSeenAt: null });
  });

  // Regression test: a friend fetching the friends list over REST (e.g. on
  // page load) used to see the true INVISIBLE status, even though the live
  // WebSocket presence broadcast already masked it as OFFLINE - a page
  // refresh fully defeated invisible mode. publicUser() now hides INVISIBLE
  // from anyone but the user themselves.
  describe("INVISIBLE status visibility", () => {
    it("reports INVISIBLE as OFFLINE to another viewer", () => {
      const result = publicUser(baseUser({ id: "user-1", presenceStatus: "INVISIBLE" }), "someone-elses-id");
      expect(result.presence.status).toBe("OFFLINE");
    });

    it("reports INVISIBLE as OFFLINE when no viewer is specified (the safe default)", () => {
      const result = publicUser(baseUser({ id: "user-1", presenceStatus: "INVISIBLE" }));
      expect(result.presence.status).toBe("OFFLINE");
    });

    it("reports the true INVISIBLE status to the user themselves", () => {
      const result = publicUser(baseUser({ id: "user-1", presenceStatus: "INVISIBLE" }), "user-1");
      expect(result.presence.status).toBe("INVISIBLE");
    });

    it("leaves every other status untouched regardless of viewer", () => {
      const result = publicUser(baseUser({ id: "user-1", presenceStatus: "BUSY" }), "someone-elses-id");
      expect(result.presence.status).toBe("BUSY");
    });
  });
});
