import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import { clearHistoryCache } from "../lib/messageCache";
import CommunityPage from "./CommunityPage";

// The messages of the channel in the address are asked for at the start of the page load, together with the lists (lib/bootPrefetch.ts, #249):
// the page uses that answer, once, and asks for itself when there is none.

const kim = { id: "u2", identity: "@kim:chat.example", username: "kim", displayName: "Kim", avatarUrl: null, bio: null, presence: { status: "ONLINE", customStatus: null } } as unknown as PublicUser;
const me = { ...kim, id: "me", identity: "@me:chat.example", username: "me", displayName: "Me" } as PublicUser;
const message = (id: string, content: string) => ({ id, sender: kim, content, invite: null, emoticons: [], attachments: [], replyTo: null, reactions: [], embeds: [], createdAt: "2026-10-29T10:00:00Z", editedAt: null, deletedAt: null }) as unknown as Message;

const live = vi.hoisted(() => ({ asked: [] as string[], prefetched: new Map<string, Promise<unknown>>() }));
vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({
    communities: [{ id: "C1", name: "Alpha", homeserverDomain: "chat.example", owner: me, members: [me, kim], roles: [], channels: [{ id: "ch1", name: "general", topic: null, type: "TEXT", position: 0, unread: false }] }],
    communitiesLoaded: true,
    refreshCommunities: vi.fn(),
  }),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me }) }));
vi.mock("../context/WsContext", () => ({ useWs: () => ({ subscribe: () => () => {} }) }));
vi.mock("../api", () => ({
  listChannelMessages: (id: string) => {
    live.asked.push(id);
    return Promise.resolve([message("own", "asked for by the page")]);
  },
  markChannelRead: () => Promise.resolve(),
  listEmoticons: () => Promise.resolve({ personal: [], saved: [], community: [] }),
  MESSAGE_PAGE_SIZE: 50,
}));
vi.mock("../lib/bootPrefetch", () => ({
  PREFETCH_KEYS: { channelMessages: (id: string) => `channel:${id}` },
  takePrefetched: (key: string) => {
    const answer = live.prefetched.get(key);
    live.prefetched.delete(key);
    return answer;
  },
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  clearHistoryCache();
  live.asked = [];
  live.prefetched.clear();
});
afterEach(cleanup);

const open = () =>
  render(
    <MemoryRouter initialEntries={["/communities/C1/ch1"]}>
      <Routes>
        <Route path="/communities/:communityId/:channelId?" element={<CommunityPage />} />
      </Routes>
    </MemoryRouter>
  );

describe("the channel's messages at the start of the page", () => {
  it("are the ones asked for at the start, and the page does not ask for them again", async () => {
    live.prefetched.set("channel:ch1", Promise.resolve([message("early", "asked for at the start")]));

    open();
    await act(async () => undefined);

    expect(screen.getByText("asked for at the start")).toBeTruthy();
    expect(screen.queryByText("asked for by the page")).toBeNull();
    expect(live.asked).toEqual([]);
  });

  it("are asked for by the page when nothing was asked for at the start", async () => {
    open();
    await act(async () => undefined);

    expect(screen.getByText("asked for by the page")).toBeTruthy();
    expect(live.asked).toEqual(["ch1"]);
  });

  it("are not taken from an answer that was asked for for another channel", async () => {
    live.prefetched.set("channel:other", Promise.resolve([message("early", "another channel's words")]));

    open();
    await act(async () => undefined);

    expect(screen.queryByText("another channel's words")).toBeNull();
    expect(live.asked).toEqual(["ch1"]);
  });
});
