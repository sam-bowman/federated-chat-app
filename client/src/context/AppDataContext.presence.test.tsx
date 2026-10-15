import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDataProvider, useAppData } from "./AppDataContext";

const refreshUser = vi.fn();
vi.mock("./AuthContext", () => ({ useAuth: () => ({ refreshUser }) }));

// A stand-in for the WebSocket: handlers by event type, fired by the test.
const bus = vi.hoisted(() => ({ handlers: new Map<string, Set<(payload: unknown) => void>>() }));
vi.mock("./WsContext", () => ({
  useWs: () => ({
    subscribe: (type: string, handler: (payload: unknown) => void) => {
      if (!bus.handlers.has(type)) bus.handlers.set(type, new Set());
      bus.handlers.get(type)!.add(handler);
      return () => bus.handlers.get(type)!.delete(handler);
    },
  }),
}));

vi.mock("../api", () => ({
  listConversations: () => Promise.resolve([]),
  listCommunities: () => Promise.resolve([]),
  listFriends: () => Promise.resolve([]),
  listFriendRequests: () => Promise.resolve([]),
}));

const fire = (type: string, payload: unknown = {}) => act(() => bus.handlers.get(type)?.forEach((h) => h(payload)));

function Probe() {
  useAppData();
  return null;
}

beforeEach(() => {
  bus.handlers.clear();
  refreshUser.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("your own status", () => {
  // The signed-in user's status was read once, at sign-in, before the connection that marks you online
  // existed, so the footer said offline while you were connected.
  it("is read again when the server says it changed, or that you connected", () => {
    render(
      <AppDataProvider>
        <Probe />
      </AppDataProvider>
    );

    fire("presence:self", { status: "ONLINE", customStatus: null });

    expect(refreshUser).toHaveBeenCalledOnce();
  });

  it("is read again for every change, including one made on another device", () => {
    render(
      <AppDataProvider>
        <Probe />
      </AppDataProvider>
    );

    fire("presence:self", { status: "BUSY", customStatus: null });
    fire("presence:self", { status: "BUSY", customStatus: "in a meeting" });

    expect(refreshUser).toHaveBeenCalledTimes(2);
  });

  it("is not read again for a friend's change, which is a different event", () => {
    render(
      <AppDataProvider>
        <Probe />
      </AppDataProvider>
    );

    fire("presence", { userId: "friend", status: "AWAY", customStatus: null });

    expect(refreshUser).not.toHaveBeenCalled();
  });

  it("stops listening when the app data goes away", () => {
    const { unmount } = render(
      <AppDataProvider>
        <Probe />
      </AppDataProvider>
    );
    unmount();

    fire("presence:self", { status: "AWAY", customStatus: null });

    expect(refreshUser).not.toHaveBeenCalled();
  });
});
