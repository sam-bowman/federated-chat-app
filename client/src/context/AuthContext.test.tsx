import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

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
