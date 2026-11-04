import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_PREFIX,
  activateSession,
  adoptLegacySession,
  claimLegacySession,
  getActiveId,
  getActiveSession,
  getSyncCursor,
  listSessions,
  readSession,
  removeSession,
  sessionId,
  setSyncCursor,
  startSession,
  updateTokens,
} from "./accountSessions";

const A = "http://localhost:4000";
const B = "https://chat.bob.test";

const server = { origin: A, domain: "alice.test", serverName: "Alice's", registrationEnabled: true };
const signIn = (username: string, origin = A, tokens = { accessToken: "a-" + username, refreshToken: "r-" + username }) =>
  startSession({ ...server, origin, username, ...tokens });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("keeping several accounts", () => {
  it("keeps each account's own tokens, and this tab uses the one that signed in last", () => {
    const alice = signIn("alice");
    const bob = signIn("bob", B);

    expect(readSession(alice.id)).toMatchObject({ accessToken: "a-alice", refreshToken: "r-alice", origin: A });
    expect(readSession(bob.id)).toMatchObject({ accessToken: "a-bob", refreshToken: "r-bob", origin: B });
    expect(getActiveId()).toBe(bob.id);
  });

  it("is the same account whatever the case of the name or the address", () => {
    expect(sessionId("HTTP://Localhost:4000", "Alice")).toBe(sessionId("http://localhost:4000", "alice"));
    signIn("alice");
    signIn("ALICE", "HTTP://LOCALHOST:4000", { accessToken: "second", refreshToken: "second-r" });
    expect(listSessions()).toHaveLength(1);
    expect(listSessions()[0].accessToken).toBe("second");
  });

  it("takes the account's domain from the identity the server gave, not from the address it is reached at", () => {
    const session = startSession({ ...server, origin: "https://api.chat.example.com", domain: "api.chat.example.com", username: "alice", identity: "@alice:chat.example.com", accessToken: "a", refreshToken: "r" });
    expect(session.domain).toBe("chat.example.com");
  });

  it("refreshing one account's tokens leaves every other account's alone", () => {
    const alice = signIn("alice");
    const bob = signIn("bob");

    updateTokens(alice.id, "new-a", "new-r");

    expect(readSession(alice.id)).toMatchObject({ accessToken: "new-a", refreshToken: "new-r" });
    expect(readSession(bob.id)).toMatchObject({ accessToken: "a-bob", refreshToken: "r-bob" });
  });

  it("does not bring back an account that was signed out while its tokens were being refreshed", () => {
    const alice = signIn("alice");
    removeSession(alice.id);
    updateTokens(alice.id, "late", "late");
    expect(readSession(alice.id)).toBeNull();
    expect(listSessions()).toEqual([]);
  });

  it("lists the accounts, the one used most recently first", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(3000).mockReturnValueOnce(2000);
    signIn("alice");
    signIn("bob");
    signIn("carol");
    expect(listSessions().map((s) => s.username)).toEqual(["bob", "carol", "alice"]);
  });
});

describe("which account a tab uses", () => {
  it("is the tab's own choice: a tab that has chosen is not moved when another account is used elsewhere", () => {
    const alice = signIn("alice");
    expect(getActiveId()).toBe(alice.id);

    // Another tab signs in as bob: it shares localStorage, but not this tab's sessionStorage.
    const bob = signIn("bob");
    sessionStorage.setItem("chat.activeAccount", alice.id); // what this tab had chosen
    localStorage.setItem("chat.lastAccount", bob.id);

    expect(getActiveId()).toBe(alice.id);
    expect(getActiveSession()?.username).toBe("alice");
  });

  it("starts a new tab on the account used last, and keeps it there", () => {
    signIn("alice");
    const bob = signIn("bob");
    sessionStorage.clear(); // a new tab

    expect(getActiveId()).toBe(bob.id);
    expect(sessionStorage.getItem("chat.activeAccount")).toBe(bob.id); // kept, so a later switch elsewhere does not move it
  });

  it("never falls back to another account when its own has been signed out: it has none, so no request goes out as someone else", () => {
    const alice = signIn("alice");
    const bob = signIn("bob");
    sessionStorage.setItem("chat.activeAccount", alice.id);
    localStorage.setItem("chat.lastAccount", bob.id);

    // Signed out from another tab: that tab removes the record from the shared storage and cannot touch this tab's own choice.
    localStorage.removeItem(SESSION_PREFIX + alice.id);

    expect(getActiveId()).toBeNull();
    expect(getActiveSession()).toBeNull();
    expect(readSession(bob.id)).not.toBeNull(); // bob is still signed in, for a tab that chooses him
  });

  it("is nobody when nobody is signed in, and when what was last used has gone", () => {
    expect(getActiveId()).toBeNull();
    const alice = signIn("alice");
    removeSession(alice.id);
    sessionStorage.clear();
    expect(getActiveId()).toBeNull();
    expect(localStorage.getItem("chat.lastAccount")).toBeNull();
  });

  it("activateSession makes this tab use the account, and new tabs start on it", () => {
    const alice = signIn("alice");
    signIn("bob");
    activateSession(alice.id);
    expect(getActiveId()).toBe(alice.id);
    expect(localStorage.getItem("chat.lastAccount")).toBe(alice.id);
  });
});

describe("signing an account out of this device", () => {
  it("removes its tokens and its sync position, and nobody else's", () => {
    const alice = signIn("alice");
    const bob = signIn("bob");
    setSyncCursor(alice.id, "alice-cursor");
    setSyncCursor(bob.id, "bob-cursor");

    removeSession(alice.id);

    expect(readSession(alice.id)).toBeNull();
    expect(getSyncCursor(alice.id)).toBeUndefined();
    expect(getSyncCursor(bob.id)).toBe("bob-cursor");
    expect(readSession(bob.id)).not.toBeNull();
    expect(Object.keys(localStorage).filter((k) => k.includes("alice"))).toEqual([]);
  });

  it("gives each account its own place in the event stream", () => {
    const alice = signIn("alice");
    const bob = signIn("bob");
    expect(getSyncCursor(alice.id)).toBeUndefined();
    setSyncCursor(alice.id, "17");
    expect(getSyncCursor(alice.id)).toBe("17");
    expect(getSyncCursor(bob.id)).toBeUndefined();
  });
});

describe("what is stored is not trusted", () => {
  it("ignores a value that is corrupt, hand-edited, or from a server that is not http(s)", () => {
    const good = signIn("alice");
    localStorage.setItem(SESSION_PREFIX + "x|corrupt", "{not json");
    localStorage.setItem(SESSION_PREFIX + "x|array", "[]");
    localStorage.setItem(SESSION_PREFIX + "x|js", JSON.stringify({ origin: "javascript:alert(1)", username: "m", accessToken: "a", refreshToken: "r" }));
    localStorage.setItem(SESSION_PREFIX + "x|notokens", JSON.stringify({ origin: A, username: "m", accessToken: "", refreshToken: "" }));
    localStorage.setItem(SESSION_PREFIX + "x|numbers", JSON.stringify({ origin: A, username: 5, accessToken: 1, refreshToken: 2 }));

    expect(listSessions().map((s) => s.id)).toEqual([good.id]);
    expect(readSession("x|corrupt")).toBeNull();
  });

  it("copies the known fields only: nothing else in a stored value is carried along", () => {
    localStorage.setItem(
      SESSION_PREFIX + "x|y",
      JSON.stringify({ origin: A, username: "mallory", accessToken: "a", refreshToken: "r", isAdmin: true, __proto__: { polluted: 1 }, extra: "<img onerror=x>" })
    );
    const read = readSession("x|y")!;
    expect(Object.keys(read).sort()).toEqual(["accessToken", "domain", "id", "lastUsedAt", "origin", "refreshToken", "registrationEnabled", "serverName", "username"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("is a list with nobody in it, not an error, when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(listSessions()).toEqual([]);
    expect(getActiveId()).toBeNull();
    expect(readSession("x")).toBeNull();
  });

  it("does not throw when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => signIn("alice")).not.toThrow();
    expect(() => setSyncCursor("x", "1")).not.toThrow();
  });
});

describe("a client signed in before accounts were kept", () => {
  const legacy = () => {
    localStorage.setItem("chat.accessToken", "old-access");
    localStorage.setItem("chat.refreshToken", "old-refresh");
    localStorage.setItem("chat.syncCursor", "42");
  };

  it("becomes an account, so an update signs nobody out, and the old keys are gone", () => {
    legacy();
    adoptLegacySession(server);

    const active = getActiveSession()!;
    expect(active).toMatchObject({ accessToken: "old-access", refreshToken: "old-refresh", origin: A, username: "" });
    expect(getSyncCursor(active.id)).toBe("42");
    expect(["chat.accessToken", "chat.refreshToken", "chat.syncCursor"].map((k) => localStorage.getItem(k))).toEqual([null, null, null]);
  });

  it("is given its real name once the server says whose it is, keeping its tokens and place in the stream", () => {
    legacy();
    adoptLegacySession(server);

    const id = claimLegacySession({ username: "alice", identity: "@alice:alice.test" });

    expect(id).toBe(sessionId(A, "alice"));
    expect(getActiveId()).toBe(id);
    expect(listSessions()).toHaveLength(1);
    expect(readSession(id!)).toMatchObject({ username: "alice", domain: "alice.test", accessToken: "old-access" });
    expect(getSyncCursor(id!)).toBe("42");
  });

  it("is not claimed by an account that already has a name", () => {
    const alice = signIn("alice");
    expect(claimLegacySession({ username: "mallory" })).toBeNull();
    expect(readSession(alice.id)?.username).toBe("alice");
  });

  it("does nothing without old tokens, or without a server to say where they belong", () => {
    adoptLegacySession(server);
    expect(listSessions()).toEqual([]);
    legacy();
    adoptLegacySession(null);
    adoptLegacySession({ ...server, origin: "ftp://nope" });
    expect(listSessions()).toEqual([]);
    expect(localStorage.getItem("chat.accessToken")).toBe("old-access"); // left for a time the server is known
  });
});
