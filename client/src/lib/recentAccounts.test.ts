import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRecentAccounts,
  forgetAccount,
  getRecentAccounts,
  isRememberEnabled,
  MAX_RECENT_ACCOUNTS,
  RECENT_ACCOUNTS_KEY,
  rememberAccount,
  setRememberEnabled,
  usernamesForServer,
} from "./recentAccounts";

const alice = { origin: "https://chat.example.com", domain: "chat.example.com", serverName: "Chat", username: "alice" };
const bob = { origin: "https://friends.example.org", domain: "friends.example.org", serverName: "Friends", username: "bob" };

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("recent accounts", () => {
  it("is empty by default", () => {
    expect(getRecentAccounts()).toEqual([]);
  });

  it("remembers accounts, most recent first", () => {
    rememberAccount(alice, 1000);
    rememberAccount(bob, 2000);
    expect(getRecentAccounts().map((a) => a.username)).toEqual(["bob", "alice"]);
  });

  it("de-duplicates the same account case-insensitively and moves it to the top", () => {
    rememberAccount(alice, 1000);
    rememberAccount(bob, 2000);
    rememberAccount({ ...alice, username: "Alice", origin: "https://CHAT.example.com", serverName: "Renamed" }, 3000);
    const accounts = getRecentAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ username: "Alice", serverName: "Renamed", lastUsedAt: 3000 });
  });

  it("keeps different usernames on the same server as separate entries", () => {
    rememberAccount(alice, 1000);
    rememberAccount({ ...alice, username: "alice2" }, 2000);
    expect(usernamesForServer(getRecentAccounts(), alice.origin)).toEqual(["alice2", "alice"]);
  });

  it("caps the list, dropping the oldest", () => {
    for (let i = 0; i < MAX_RECENT_ACCOUNTS + 3; i++) {
      rememberAccount({ ...alice, username: `user${i}` }, i);
    }
    const accounts = getRecentAccounts();
    expect(accounts).toHaveLength(MAX_RECENT_ACCOUNTS);
    expect(accounts[0].username).toBe(`user${MAX_RECENT_ACCOUNTS + 2}`);
    expect(accounts.some((a) => a.username === "user0")).toBe(false);
  });

  it("forgets one entry, and clears all", () => {
    rememberAccount(alice, 1000);
    rememberAccount(bob, 2000);
    forgetAccount(alice);
    expect(getRecentAccounts().map((a) => a.username)).toEqual(["bob"]);
    clearRecentAccounts();
    expect(getRecentAccounts()).toEqual([]);
    expect(localStorage.getItem(RECENT_ACCOUNTS_KEY)).toBeNull();
  });

  it("stores no password or token fields", () => {
    rememberAccount({ ...alice, password: "hunter2", accessToken: "t" } as typeof alice, 1000);
    const stored = localStorage.getItem(RECENT_ACCOUNTS_KEY) ?? "";
    expect(stored).not.toContain("hunter2");
    expect(stored).not.toMatch(/token|password/i);
  });

  it("does nothing while remembering is switched off", () => {
    setRememberEnabled(false);
    expect(isRememberEnabled()).toBe(false);
    rememberAccount(alice, 1000);
    expect(getRecentAccounts()).toEqual([]);
    setRememberEnabled(true);
    expect(isRememberEnabled()).toBe(true);
  });

  it("refuses non-http(s) origins and empty usernames", () => {
    rememberAccount({ ...alice, origin: "javascript:alert(1)" }, 1000);
    rememberAccount({ ...alice, username: "" }, 1000);
    expect(getRecentAccounts()).toEqual([]);
  });

  it("ignores corrupt stored values without throwing", () => {
    const corrupt = ["not json", "null", "42", '{"version":1}', '{"version":2,"accounts":[]}', '{"version":1,"accounts":"x"}'];
    for (const bad of corrupt) {
      localStorage.setItem(RECENT_ACCOUNTS_KEY, bad);
      expect(getRecentAccounts()).toEqual([]);
    }
  });

  it("drops invalid entries but keeps valid ones", () => {
    localStorage.setItem(
      RECENT_ACCOUNTS_KEY,
      JSON.stringify({
        version: 1,
        accounts: [
          null,
          { ...alice, lastUsedAt: 5 },
          { ...bob, origin: "javascript:alert(1)", lastUsedAt: 6 },
          { ...bob, lastUsedAt: "soon" },
          { ...bob, username: 7, lastUsedAt: 7 },
        ],
      })
    );
    expect(getRecentAccounts().map((a) => a.username)).toEqual(["alice"]);
  });

  it("survives localStorage throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(getRecentAccounts()).toEqual([]);
    expect(() => rememberAccount(alice)).not.toThrow();
    expect(isRememberEnabled()).toBe(true);
  });
});
