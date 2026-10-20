import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sync } from "../api";
import { WsProvider, useWs } from "./WsContext";

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
  SYNC_CURSOR_KEY: "chat.syncCursor",
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

describe("WsProvider announcing that the connection is open", () => {
  it("tells listeners each time the socket (re)connects, so state that is only ever pushed can be asked for again", async () => {
    mockUseAuth.mockReturnValue({ user: { id: "user-1", displayName: "Alice" } });
    const opened = vi.fn();
    function Listener() {
      const { subscribe } = useWs();
      subscribe("ws:open", opened);
      return null;
    }
    render(
      <WsProvider>
        <Listener />
      </WsProvider>
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(opened).not.toHaveBeenCalled();

    FakeWebSocket.instances[0].onopen?.();
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));

    // The connection drops and comes back: a second socket, a second announcement.
    FakeWebSocket.instances[0].onclose?.();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 });
    FakeWebSocket.instances[1].onopen?.();
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(2));
  });
});

describe("WsProvider catching up", () => {
  // Catching up hands back events, including ones already seen live (the cursor only moves when it catches up, so every
  // reconnection replays what came since): a listener that only wants things as they happen has to be able to tell.
  it("marks what it replays while catching up as replayed, and leaves what arrives live as it is", async () => {
    mockUseAuth.mockReturnValue({ user: { id: "user-1", displayName: "Alice" } });
    vi.mocked(sync).mockResolvedValueOnce({ events: [{ type: "message:created", payload: { conversationId: "old" } }], nextCursor: "1", hasMore: false } as never);
    const heard: unknown[] = [];
    function Listener() {
      const { subscribe } = useWs();
      subscribe("message:created", (payload) => heard.push(payload));
      return null;
    }
    render(
      <WsProvider>
        <Listener />
      </WsProvider>
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].onopen?.();
    await waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]).toEqual({ conversationId: "old", replayed: true });

    FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "message:created", conversationId: "new" }) });
    expect(heard[1]).toEqual({ type: "message:created", conversationId: "new" });
    expect(heard[1]).not.toHaveProperty("replayed");
  });
});
