import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsProvider } from "./WsContext";

const mockUseAuth = vi.fn();
vi.mock("./AuthContext", () => ({
  useAuth: () => mockUseAuth(),
}));
vi.mock("../api", () => ({
  wsUrl: () => "ws://test.local/ws",
  sync: vi.fn(async () => ({ events: [], nextCursor: "0", hasMore: false })),
}));
vi.mock("../api/client", () => ({
  ensureFreshAccessToken: vi.fn(async () => "test-token"),
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Regression test for a real bug: SettingsPage's refreshUser() call (after
// any profile/presence change) produces a brand new `user` object from
// AuthContext on every call. WsProvider's socket-opening effect used to
// depend on that whole object ([user]), so a presence change alone
// re-triggered it - tearing down and reopening the WebSocket, which made the
// server briefly see the user as offline-then-online and silently reverted
// a manually-set status like BUSY back to ONLINE. The fix keys the effect
// off a stable id instead, so only an actual identity change (login/logout/
// switch account) should reopen the socket.
describe("WsProvider socket lifecycle", () => {
  it("does not reopen the socket when the user object is replaced but its id is unchanged", async () => {
    mockUseAuth.mockReturnValue({ user: { id: "user-1", displayName: "Alice" } });
    const { rerender } = render(
      <WsProvider>
        <div />
      </WsProvider>
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    // A different object, same id - exactly what AuthContext.refreshUser()
    // produces after e.g. a presence change.
    mockUseAuth.mockReturnValue({ user: { id: "user-1", displayName: "Alice (now Busy)" } });
    rerender(
      <WsProvider>
        <div />
      </WsProvider>
    );

    // Give any (incorrect) reconnect effect a chance to run before asserting
    // it didn't.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does reopen the socket when the user id actually changes (e.g. switching accounts)", async () => {
    mockUseAuth.mockReturnValue({ user: { id: "user-1", displayName: "Alice" } });
    const { rerender } = render(
      <WsProvider>
        <div />
      </WsProvider>
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    mockUseAuth.mockReturnValue({ user: { id: "user-2", displayName: "Bob" } });
    rerender(
      <WsProvider>
        <div />
      </WsProvider>
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
  });

  it("closes the socket when the user logs out (user becomes null)", async () => {
    mockUseAuth.mockReturnValue({ user: { id: "user-1", displayName: "Alice" } });
    const { rerender } = render(
      <WsProvider>
        <div />
      </WsProvider>
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const firstSocket = FakeWebSocket.instances[0];

    mockUseAuth.mockReturnValue({ user: null });
    rerender(
      <WsProvider>
        <div />
      </WsProvider>
    );

    await waitFor(() => expect(firstSocket.close).toHaveBeenCalled());
  });
});
