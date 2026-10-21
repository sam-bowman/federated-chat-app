import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDataProvider, useAppData } from "./AppDataContext";

vi.mock("./AuthContext", () => ({ useAuth: () => ({ refreshUser: vi.fn() }) }));

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

const api = vi.hoisted(() => ({
  listConversations: vi.fn(),
  listCommunities: vi.fn(),
  listFriends: vi.fn(),
  listFriendRequests: vi.fn(),
}));
vi.mock("../api", () => api);

const fire = (type: string, payload: unknown = {}) => act(() => bus.handlers.get(type)?.forEach((h) => h(payload)));

function Probe() {
  useAppData();
  return null;
}

beforeEach(() => {
  bus.handlers.clear();
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

describe("when someone deletes their account (#60)", () => {
  it("looks again at friends, requests, chats and communities, since they are in none of them any more", async () => {
    render(
      <AppDataProvider>
        <Probe />
      </AppDataProvider>
    );
    await waitFor(() => expect(api.listFriends).toHaveBeenCalled());
    const before = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, fn.mock.calls.length]));

    fire("user:deleted", { userId: "someone" });

    await waitFor(() => {
      for (const [name, fn] of Object.entries(api)) expect(fn.mock.calls.length, name).toBeGreaterThan(before[name]);
    });
  });
});
