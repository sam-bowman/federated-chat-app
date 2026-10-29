import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

// What the person is, asked for at the start of the page load (lib/bootPrefetch.ts, #249): used when it is there, never for someone else, and
// a status that arrives later is taken from the event instead of asking for the whole person again.

const mockApi = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  verifyTotpLogin: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("../api", () => mockApi);
vi.mock("../api/client", () => ({
  getHomeServer: () => ({ origin: "http://localhost:4000", domain: "alice.test", serverName: "A", registrationEnabled: true }),
  setHomeServer: vi.fn(),
  clearHomeServer: vi.fn(),
  isFixedServerMode: () => true,
  clearTokens: vi.fn(),
  SYNC_CURSOR_KEY: "chat.syncCursor",
}));
vi.mock("../api/discovery", () => ({
  parseServerInput: vi.fn(),
  discoverHomeServer: vi.fn().mockResolvedValue({ origin: "http://localhost:4000", domain: "alice.test", serverName: "A", registrationEnabled: true }),
}));

const prefetch = vi.hoisted(() => ({ taken: undefined as Promise<unknown> | undefined, cleared: 0 }));
vi.mock("../lib/bootPrefetch", () => ({
  PREFETCH_KEYS: { me: "me" },
  takePrefetched: () => {
    const promise = prefetch.taken;
    prefetch.taken = undefined;
    return promise;
  },
  clearBootPrefetch: () => {
    prefetch.cleared++;
  },
}));

const user = { id: "u1", username: "alice", identity: "@alice:alice.test", presence: { status: "OFFLINE", customStatus: null, lastSeenAt: "2026-10-29T09:00:00Z" } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  prefetch.taken = undefined;
  prefetch.cleared = 0;
  mockApi.getAccessToken.mockReturnValue("token");
});
afterEach(() => localStorage.clear());

const renderAuth = () => renderHook(() => useAuth(), { wrapper: AuthProvider });

describe("restoring the session at the start of the page", () => {
  it("uses the answer that was asked for at the start, and does not ask again", async () => {
    prefetch.taken = Promise.resolve(user);
    const { result } = renderAuth();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual(user);
    expect(mockApi.me).not.toHaveBeenCalled();
  });

  it("asks for itself when nothing was asked for at the start", async () => {
    mockApi.me.mockResolvedValue(user);
    const { result } = renderAuth();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual(user);
    expect(mockApi.me).toHaveBeenCalledTimes(1);
  });

  it("treats a failed answer from the start like a failed request: signed out, and not stuck loading", async () => {
    prefetch.taken = Promise.reject(new Error("401"));
    const { result } = renderAuth();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
  });
});

describe("what was asked for at the start is for whoever was signed in then", () => {
  it.each([
    ["signing in", (auth: ReturnType<typeof useAuth>) => auth.login("alice", "pw")],
    ["registering", (auth: ReturnType<typeof useAuth>) => auth.register("alice", "pw")],
    ["finishing a two-factor sign-in", (auth: ReturnType<typeof useAuth>) => auth.verifyTotpLogin("challenge", { code: "123456" })],
    ["signing out", async (auth: ReturnType<typeof useAuth>) => auth.logout()],
    ["switching server", async (auth: ReturnType<typeof useAuth>) => auth.switchServer()],
  ])("is forgotten when %s", async (_name, act_) => {
    mockApi.me.mockResolvedValue(user);
    mockApi.login.mockResolvedValue(user);
    mockApi.register.mockResolvedValue(user);
    mockApi.verifyTotpLogin.mockResolvedValue(user);
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = prefetch.cleared;

    await act(async () => void (await act_(result.current)));

    expect(prefetch.cleared).toBeGreaterThan(before);
  });
});

describe("your own status", () => {
  it("is set from what the server says, keeping the rest of the person as it was", async () => {
    mockApi.me.mockResolvedValue(user);
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.user).not.toBeNull());

    act(() => result.current.applyPresence("BUSY", "in a meeting"));

    // Only the status and the custom status change; what else the presence holds (when you were last seen) stays.
    expect(result.current.user).toEqual({
      ...(user as object),
      presence: { status: "BUSY", customStatus: "in a meeting", lastSeenAt: "2026-10-29T09:00:00Z" },
    });
    expect(mockApi.me).toHaveBeenCalledTimes(1); // not asked for again
  });

  it("does nothing when nobody is signed in", async () => {
    mockApi.getAccessToken.mockReturnValue(null);
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.applyPresence("ONLINE", null));

    expect(result.current.user).toBeNull();
  });
});
