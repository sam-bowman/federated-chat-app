import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDataProvider, useAppData } from "./AppDataContext";

// The lists were asked for at the start of the page load (lib/bootPrefetch.ts, #249): used when they are there, asked for when they are not.

vi.mock("./AuthContext", () => ({ useAuth: () => ({ applyPresence: vi.fn() }) }));
vi.mock("./WsContext", () => ({ useWs: () => ({ subscribe: () => () => {} }) }));

const mockApi = vi.hoisted(() => ({
  listConversations: vi.fn(),
  listCommunities: vi.fn(),
  listFriends: vi.fn(),
  listFriendRequests: vi.fn(),
}));
vi.mock("../api", () => mockApi);

const prefetched = vi.hoisted(() => ({ answers: new Map<string, Promise<unknown>>() }));
vi.mock("../lib/bootPrefetch", () => ({
  PREFETCH_KEYS: { conversations: "c", communities: "g", friends: "f", incomingRequests: "r" },
  takePrefetched: (key: string) => {
    const answer = prefetched.answers.get(key);
    prefetched.answers.delete(key);
    return answer;
  },
}));

function Probe() {
  const data = useAppData();
  return (
    <p>
      {data.conversations.length} chats, {data.communities.length} communities ({data.communitiesLoaded ? "loaded" : "not loaded"}), {data.friends.length} friends,{" "}
      {data.incomingRequests.length} requests
    </p>
  );
}

beforeEach(() => {
  prefetched.answers.clear();
  mockApi.listConversations.mockResolvedValue([{ id: "d1" }]);
  mockApi.listCommunities.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
  mockApi.listFriends.mockResolvedValue([{ id: "f1" }]);
  mockApi.listFriendRequests.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the first lists", () => {
  it("are the ones asked for at the start, and are not asked for a second time", async () => {
    prefetched.answers.set("c", Promise.resolve([{ id: "d1" }, { id: "d2" }, { id: "d3" }]));
    prefetched.answers.set("g", Promise.resolve([{ id: "c1" }]));
    prefetched.answers.set("f", Promise.resolve([]));
    prefetched.answers.set("r", Promise.resolve([{ id: "r1" }, { id: "r2" }]));

    render(
      <AppDataProvider>
        <Probe />
      </AppDataProvider>
    );

    await screen.findByText("3 chats, 1 communities (loaded), 0 friends, 2 requests");
    expect(mockApi.listConversations).not.toHaveBeenCalled();
    expect(mockApi.listCommunities).not.toHaveBeenCalled();
    expect(mockApi.listFriends).not.toHaveBeenCalled();
    expect(mockApi.listFriendRequests).not.toHaveBeenCalled();
  });

  it("are asked for when nothing was asked for at the start, and the communities are not 'loaded' before they arrive", async () => {
    render(
      <AppDataProvider>
        <Probe />
      </AppDataProvider>
    );

    expect(screen.getByText(/0 communities \(not loaded\)/)).toBeTruthy();
    await screen.findByText("1 chats, 2 communities (loaded), 1 friends, 0 requests");
    expect(mockApi.listFriendRequests).toHaveBeenCalledExactlyOnceWith("incoming");
  });

  it("take what is there and ask for what is not", async () => {
    prefetched.answers.set("g", Promise.resolve([{ id: "c1" }]));

    render(
      <AppDataProvider>
        <Probe />
      </AppDataProvider>
    );

    await screen.findByText("1 chats, 1 communities (loaded), 1 friends, 0 requests");
    expect(mockApi.listCommunities).not.toHaveBeenCalled();
    expect(mockApi.listConversations).toHaveBeenCalledTimes(1);
  });

  it("leave an answer that failed as not loaded, without an error nobody handles, and keep the other lists", async () => {
    prefetched.answers.set("g", Promise.reject(new Error("401")));

    render(
      <AppDataProvider>
        <Probe />
      </AppDataProvider>
    );
    await waitFor(() => expect(screen.getByText(/1 chats/)).toBeTruthy());
    await act(async () => undefined);

    expect(screen.getByText(/0 communities \(not loaded\)/)).toBeTruthy();
  });
});
