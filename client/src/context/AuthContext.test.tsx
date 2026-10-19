import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";
import { getRecentAccounts, setRememberEnabled } from "../lib/recentAccounts";

const mockApi = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  verifyTotpLogin: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("../api", () => mockApi);

const mockClient = vi.hoisted(() => ({
  getHomeServer: vi.fn(),
  setHomeServer: vi.fn(),
  clearHomeServer: vi.fn(),
  isFixedServerMode: vi.fn(),
  clearTokens: vi.fn(),
  SYNC_CURSOR_KEY: "chat.syncCursor",
}));
vi.mock("../api/client", () => mockClient);

const mockDiscovery = vi.hoisted(() => ({
  parseServerInput: vi.fn(),
  discoverHomeServer: vi.fn(),
}));
vi.mock("../api/discovery", () => mockDiscovery);

const sampleServerA = { origin: "http://localhost:4000", domain: "alice.test", serverName: "A", registrationEnabled: true };
const sampleServerB = { origin: "http://localhost:4001", domain: "bob.test", serverName: "B", registrationEnabled: true };
const sampleUser = { id: "user-1", username: "alice" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

function renderAuth() {
  return renderHook(() => useAuth(), { wrapper: AuthProvider });
}

describe("AuthProvider mount behavior", () => {
  it("fixed mode: restores the session via api.me() when a token exists", async () => {
    mockClient.isFixedServerMode.mockReturnValue(true);
    mockClient.getHomeServer.mockReturnValue(sampleServerA);
    mockApi.getAccessToken.mockReturnValue("token");
    mockApi.me.mockResolvedValue(sampleUser);
    mockDiscovery.discoverHomeServer.mockResolvedValue(sampleServerA);

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual(sampleUser);
  });

  it("picker mode, no stored server: skips api.me() and resolves loading immediately", async () => {
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValue(null);

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(result.current.homeServer).toBeNull();
    expect(mockApi.me).not.toHaveBeenCalled();
  });

  it("picker mode, stored server: behaves like fixed mode and restores the session", async () => {
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValue(sampleServerB);
    mockApi.getAccessToken.mockReturnValue("token");
    mockApi.me.mockResolvedValue(sampleUser);

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual(sampleUser);
    expect(result.current.homeServer).toEqual(sampleServerB);
  });

  it("fixed mode: a failed background discovery leaves the origin-only home server in place", async () => {
    mockClient.isFixedServerMode.mockReturnValue(true);
    mockClient.getHomeServer.mockReturnValue(sampleServerA);
    mockApi.getAccessToken.mockReturnValue(null);
    mockDiscovery.discoverHomeServer.mockRejectedValue(new Error("network down"));

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.homeServer).toEqual(sampleServerA);
    expect(mockClient.setHomeServer).not.toHaveBeenCalled();
  });
});

describe("resolveHomeServer", () => {
  it("clears the session when resolving to a different domain than what's currently stored", async () => {
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValueOnce(null).mockReturnValueOnce(sampleServerA);
    mockDiscovery.parseServerInput.mockReturnValue({ domainOrOrigin: "bob.test" });
    mockDiscovery.discoverHomeServer.mockResolvedValue(sampleServerB);

    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.resolveHomeServer("bob.test");
    });

    expect(mockClient.clearTokens).toHaveBeenCalled();
    expect(mockClient.setHomeServer).toHaveBeenCalledWith(sampleServerB);
    expect(result.current.homeServer).toEqual(sampleServerB);
  });

  it("does not clear the session when re-resolving the same domain", async () => {
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValue(sampleServerA);
    mockDiscovery.parseServerInput.mockReturnValue({ domainOrOrigin: "alice.test" });
    mockDiscovery.discoverHomeServer.mockResolvedValue(sampleServerA);

    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.resolveHomeServer("alice.test");
    });

    expect(mockClient.clearTokens).not.toHaveBeenCalled();
    expect(mockClient.setHomeServer).toHaveBeenCalledWith(sampleServerA);
  });
});

describe("login / verifyTotpLogin", () => {
  it("sets the session directly when the account has no 2FA challenge", async () => {
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValue(sampleServerA);
    mockApi.login.mockResolvedValue(sampleUser);

    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));

    let returned;
    await act(async () => {
      returned = await result.current.login("alice", "pw");
    });

    expect(returned).toBeUndefined();
    expect(result.current.user).toEqual(sampleUser);
  });

  // Regression target: a challenge token must never be mistaken for a
  // signed-in session - the account's real user shouldn't be set until
  // verifyTotpLogin() actually redeems the challenge.
  it("returns the challenge without setting the session when 2FA is required", async () => {
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValue(sampleServerA);
    mockApi.login.mockResolvedValue({ totpRequired: true, challengeToken: "challenge-abc" });

    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));

    let returned;
    await act(async () => {
      returned = await result.current.login("alice", "pw");
    });

    expect(returned).toEqual({ totpRequired: true, challengeToken: "challenge-abc" });
    expect(result.current.user).toBeNull();
  });

  it("sets the session once verifyTotpLogin redeems the challenge", async () => {
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValue(sampleServerA);
    mockApi.verifyTotpLogin.mockResolvedValue(sampleUser);

    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.verifyTotpLogin("challenge-abc", { code: "123456" });
    });

    expect(mockApi.verifyTotpLogin).toHaveBeenCalledWith("challenge-abc", { code: "123456" });
    expect(result.current.user).toEqual(sampleUser);
  });
});

describe("switchServer", () => {
  it("clears tokens, the remembered server, and the in-memory user/homeServer state", async () => {
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValue(sampleServerA);
    mockApi.getAccessToken.mockReturnValue("token");
    mockApi.me.mockResolvedValue(sampleUser);

    const { result } = renderAuth();
    await waitFor(() => expect(result.current.user).toEqual(sampleUser));

    act(() => {
      result.current.switchServer();
    });

    expect(mockClient.clearTokens).toHaveBeenCalled();
    expect(mockClient.clearHomeServer).toHaveBeenCalled();
    expect(result.current.user).toBeNull();
    expect(result.current.homeServer).toBeNull();
  });
});

describe("remembered accounts", () => {
  const alice = { id: "user-1", username: "alice", identity: "@alice:alice.test" } as any;

  async function renderSignedOut() {
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValue(sampleServerA);
    mockApi.getAccessToken.mockReturnValue(null);
    const rendered = renderAuth();
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    return rendered;
  }

  it("remembers the account after a successful sign-in", async () => {
    mockApi.login.mockResolvedValue(alice);
    const { result } = await renderSignedOut();

    await act(async () => {
      await result.current.login("alice", "pw");
    });

    expect(getRecentAccounts()).toMatchObject([
      { origin: sampleServerA.origin, domain: "alice.test", serverName: "A", username: "alice" },
    ]);
    expect(localStorage.getItem("chat.recentAccounts")).not.toContain("pw");
  });

  it("does not remember a failed sign-in", async () => {
    mockApi.login.mockRejectedValue(new Error("invalid_credentials"));
    const { result } = await renderSignedOut();

    await act(async () => {
      await result.current.login("alice", "wrong").catch(() => {});
    });

    expect(getRecentAccounts()).toEqual([]);
  });

  it("does not remember the account while the 2FA step is still pending, only once it is redeemed", async () => {
    mockApi.login.mockResolvedValue({ totpRequired: true, challengeToken: "c" });
    mockApi.verifyTotpLogin.mockResolvedValue(alice);
    const { result } = await renderSignedOut();

    await act(async () => {
      await result.current.login("alice", "pw");
    });
    expect(getRecentAccounts()).toEqual([]);

    await act(async () => {
      await result.current.verifyTotpLogin("c", { code: "123456" });
    });
    expect(getRecentAccounts()).toHaveLength(1);
  });

  it("remembers a newly registered account", async () => {
    mockApi.register.mockResolvedValue(alice);
    const { result } = await renderSignedOut();

    await act(async () => {
      await result.current.register("alice", "pw");
    });

    expect(getRecentAccounts()).toHaveLength(1);
  });

  it("passes the invite code on to the server when registering", async () => {
    mockApi.register.mockResolvedValue(alice);
    const { result } = await renderSignedOut();

    await act(async () => {
      await result.current.register("alice", "pw", "Alice", "K7M2QXR9TB");
    });

    expect(mockApi.register).toHaveBeenCalledWith("alice", "pw", "Alice", "K7M2QXR9TB");
  });

  it("does not remember anything when the user turned remembering off", async () => {
    setRememberEnabled(false);
    mockApi.login.mockResolvedValue(alice);
    const { result } = await renderSignedOut();

    await act(async () => {
      await result.current.login("alice", "pw");
    });

    expect(getRecentAccounts()).toEqual([]);
  });

  // The address the API is reached at can be another host (api.example.com) from the one in an id (example.com), and
  // discovery may not have answered yet when someone signs in: the domain comes from the identity the server returned.
  it("remembers the domain from the person's own identity, never the host the API is reached at", async () => {
    mockClient.isFixedServerMode.mockReturnValue(true);
    mockClient.getHomeServer.mockReturnValue({
      origin: "https://api.chat.example.com",
      domain: "",
      serverName: "",
      registrationEnabled: true,
    });
    mockDiscovery.discoverHomeServer.mockReturnValue(new Promise(() => {}));
    mockApi.getAccessToken.mockReturnValue(null);
    mockApi.login.mockResolvedValue({ id: "user-1", username: "alice", identity: "@alice:chat.example.com" });
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.login("alice", "pw");
    });

    expect(getRecentAccounts()).toMatchObject([{ origin: "https://api.chat.example.com", domain: "chat.example.com", username: "alice" }]);
    expect(localStorage.getItem("chat.recentAccounts")).not.toContain('"domain":"api.chat.example.com"');
  });

  it("keeps a port in the identity's domain", async () => {
    mockApi.login.mockResolvedValue({ id: "user-1", username: "alice", identity: "@alice:localhost:4001" });
    const { result } = await renderSignedOut();
    await act(async () => {
      await result.current.login("alice", "pw");
    });
    expect(getRecentAccounts()[0].domain).toBe("localhost:4001");
  });

  it("mends a remembered account saved with the wrong domain once the server is resolved", async () => {
    localStorage.setItem(
      "chat.recentAccounts",
      JSON.stringify({
        version: 1,
        accounts: [{ origin: "https://api.chat.example.com", domain: "api.chat.example.com", serverName: "", username: "alice", lastUsedAt: 5 }],
      })
    );
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValue(null);
    mockDiscovery.parseServerInput.mockReturnValue({ domainOrOrigin: "https://api.chat.example.com" });
    mockDiscovery.discoverHomeServer.mockResolvedValue({
      origin: "https://api.chat.example.com",
      domain: "chat.example.com",
      serverName: "Example",
      registrationEnabled: true,
    });
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.resolveHomeServer("https://api.chat.example.com");
    });

    expect(getRecentAccounts()).toMatchObject([{ domain: "chat.example.com", serverName: "Example", username: "alice", lastUsedAt: 5 }]);
  });

  it("does not remember the account at all when it cannot tell what domain it is on", async () => {
    mockApi.login.mockResolvedValue({ id: "user-1", username: "alice" });
    mockClient.isFixedServerMode.mockReturnValue(true);
    mockClient.getHomeServer.mockReturnValue({ origin: "https://api.chat.example.com", domain: "", serverName: "", registrationEnabled: true });
    mockDiscovery.discoverHomeServer.mockReturnValue(new Promise(() => {}));
    mockApi.getAccessToken.mockReturnValue(null);
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.login("alice", "pw");
    });
    expect(getRecentAccounts()).toEqual([]);
  });

  it("does not remember a server just by resolving it", async () => {
    mockClient.isFixedServerMode.mockReturnValue(false);
    mockClient.getHomeServer.mockReturnValue(null);
    mockDiscovery.parseServerInput.mockReturnValue({ domainOrOrigin: "bob.test" });
    mockDiscovery.discoverHomeServer.mockResolvedValue(sampleServerB);
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.resolveHomeServer("bob.test");
    });

    expect(getRecentAccounts()).toEqual([]);
  });

  it("keeps the list when the user switches server", async () => {
    mockApi.login.mockResolvedValue(alice);
    const { result } = await renderSignedOut();
    await act(async () => {
      await result.current.login("alice", "pw");
    });

    act(() => {
      result.current.switchServer();
    });

    expect(getRecentAccounts()).toHaveLength(1);
  });
});
