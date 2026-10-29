import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREFETCH_KEYS, chatInAddress, clearBootPrefetch, startBootPrefetch, takePrefetched } from "./bootPrefetch";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  listConversations: vi.fn(),
  listCommunities: vi.fn(),
  listFriends: vi.fn(),
  listFriendRequests: vi.fn(),
  listChannelMessages: vi.fn(),
  listMessages: vi.fn(),
}));
vi.mock("../api", () => api);

const tokens = vi.hoisted(() => ({ access: "a" as string | null, refresh: "r" as string | null }));
vi.mock("../api/client", () => ({ getAccessToken: () => tokens.access, getRefreshToken: () => tokens.refresh }));

beforeEach(() => {
  vi.useFakeTimers();
  tokens.access = "a";
  tokens.refresh = "r";
  api.me.mockResolvedValue({ id: "u1" });
  api.listConversations.mockResolvedValue([]);
  api.listCommunities.mockResolvedValue([]);
  api.listFriends.mockResolvedValue([]);
  api.listFriendRequests.mockResolvedValue([]);
  api.listChannelMessages.mockResolvedValue([{ id: "m1" }]);
  api.listMessages.mockResolvedValue([{ id: "d1" }]);
});
afterEach(() => {
  clearBootPrefetch();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const everythingAsked = () => Object.values(api).reduce((n, fn) => n + fn.mock.calls.length, 0);

describe("which chat an address is of", () => {
  it("knows a channel and a conversation, with or without a trailing slash", () => {
    expect(chatInAddress("/communities/C1/CH1")).toEqual({ kind: "channel", id: "CH1" });
    expect(chatInAddress("/communities/C1/CH1/")).toEqual({ kind: "channel", id: "CH1" });
    expect(chatInAddress("/dm/D1")).toEqual({ kind: "conversation", id: "D1" });
  });

  it("knows nothing for a community alone (its channel comes from the list), the lists, settings or the admin page", () => {
    for (const path of ["/communities/C1", "/friends", "/", "/browse", "/settings", "/emoticons", "/admin/users", "/communities/C1/CH1/extra"]) {
      expect(chatInAddress(path), path).toBeNull();
    }
  });

  it("reads an id that was written percent-encoded", () => {
    expect(chatInAddress("/dm/a%3Ab")).toEqual({ kind: "conversation", id: "a:b" });
  });
});

describe("asking at the start of the page", () => {
  it("asks for the person, the four lists and the open channel's messages, all at once", () => {
    startBootPrefetch("/communities/C1/CH1");

    expect(api.me).toHaveBeenCalledTimes(1);
    expect(api.listConversations).toHaveBeenCalledTimes(1);
    expect(api.listCommunities).toHaveBeenCalledTimes(1);
    expect(api.listFriends).toHaveBeenCalledTimes(1);
    expect(api.listFriendRequests).toHaveBeenCalledExactlyOnceWith("incoming");
    expect(api.listChannelMessages).toHaveBeenCalledExactlyOnceWith("CH1");
    expect(api.listMessages).not.toHaveBeenCalled();
  });

  it("asks for a conversation's messages for a conversation's address, and for none for a page that is of no chat", () => {
    startBootPrefetch("/dm/D1");
    expect(api.listMessages).toHaveBeenCalledExactlyOnceWith("D1");
    expect(api.listChannelMessages).not.toHaveBeenCalled();

    vi.clearAllMocks();
    startBootPrefetch("/friends");
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(api.listMessages).not.toHaveBeenCalled();
    expect(api.listChannelMessages).not.toHaveBeenCalled();
  });

  it("asks for nothing when there is no token to ask with, and nothing on the sign-in pages", () => {
    tokens.access = null;
    tokens.refresh = null;
    startBootPrefetch("/communities/C1/CH1");
    expect(everythingAsked()).toBe(0);

    tokens.refresh = "r";
    startBootPrefetch("/login");
    startBootPrefetch("/register");
    expect(everythingAsked()).toBe(0);
  });

  it("asks when only the refresh token is left, since asking refreshes the access token first", () => {
    tokens.access = null;
    startBootPrefetch("/friends");
    expect(api.me).toHaveBeenCalledTimes(1);
  });
});

describe("taking the answers", () => {
  it("gives the answer that was asked for, once", async () => {
    startBootPrefetch("/communities/C1/CH1");

    await expect(takePrefetched(PREFETCH_KEYS.me)).resolves.toEqual({ id: "u1" });
    expect(takePrefetched(PREFETCH_KEYS.me)).toBeUndefined();
    await expect(takePrefetched(PREFETCH_KEYS.channelMessages("CH1"))).resolves.toEqual([{ id: "m1" }]);
  });

  it("gives nothing for a chat that is not the one in the address, so the caller asks for itself", () => {
    startBootPrefetch("/communities/C1/CH1");
    expect(takePrefetched(PREFETCH_KEYS.channelMessages("OTHER"))).toBeUndefined();
    expect(takePrefetched(PREFETCH_KEYS.conversationMessages("CH1"))).toBeUndefined();
  });

  it("gives nothing once the answer is old: what is shown a long while after the page opened is asked for again", () => {
    startBootPrefetch("/friends");
    vi.advanceTimersByTime(15_001);
    expect(takePrefetched(PREFETCH_KEYS.me)).toBeUndefined();
  });

  it("gives an answer that is just under the limit", () => {
    startBootPrefetch("/friends");
    vi.advanceTimersByTime(14_999);
    expect(takePrefetched(PREFETCH_KEYS.me)).toBeDefined();
  });

  it("gives nothing after it was cleared, which is what signing in or out and switching server do", () => {
    startBootPrefetch("/friends");
    clearBootPrefetch();
    for (const key of [PREFETCH_KEYS.me, PREFETCH_KEYS.conversations, PREFETCH_KEYS.communities, PREFETCH_KEYS.friends, PREFETCH_KEYS.incomingRequests]) {
      expect(takePrefetched(key), key).toBeUndefined();
    }
  });

  it("starting again forgets what was asked before", () => {
    startBootPrefetch("/communities/C1/CH1");
    startBootPrefetch("/friends");
    expect(takePrefetched(PREFETCH_KEYS.channelMessages("CH1"))).toBeUndefined();
  });
});

describe("a request that fails", () => {
  it("has something catching it as soon as it is stored, so it is not an unhandled rejection while nobody has asked for it yet", () => {
    const failed = Promise.reject(new Error("401"));
    const catching = vi.spyOn(failed, "catch");
    api.me.mockReturnValue(failed);

    startBootPrefetch("/friends");

    expect(catching).toHaveBeenCalledTimes(1);
  });

  it("still reaches the one who takes it, as a rejection", async () => {
    api.me.mockRejectedValue(new Error("401"));
    startBootPrefetch("/friends");

    await expect(takePrefetched(PREFETCH_KEYS.me)).rejects.toThrow("401");
  });
});
