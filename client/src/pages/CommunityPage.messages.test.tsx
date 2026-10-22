import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import { clearHistoryCache } from "../lib/messageCache";
import CommunityPage from "./CommunityPage";

const kim = {
  id: "u2",
  identity: "@kim:chat.example",
  username: "kim",
  displayName: "Kim",
  avatarUrl: null,
  bio: null,
  presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
} as PublicUser;
const me = { ...kim, id: "me", identity: "@me:chat.example", username: "me", displayName: "Me" } as PublicUser;

const message = (id: string, content: string): Message => ({
  id,
  sender: kim,
  content,
  invite: null,
  emoticons: [],
  attachments: [],
  replyTo: null,
  reactions: [],
  editedAt: null,
  deletedAt: null,
  createdAt: "2026-10-15T12:00:00.000Z",
});

const live = vi.hoisted(() => ({
  handlers: {} as Record<string, (payload: unknown) => void>,
  pending: null as Promise<unknown[]> | null,
}));
const ws = vi.hoisted(() => ({
  subscribe: (type: string, handler: (payload: unknown) => void) => {
    live.handlers[type] = handler;
    return () => {};
  },
}));
vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({
    communities: [
      {
        id: "C1",
        name: "Book Club",
        homeserverDomain: "chat.example",
        owner: me,
        members: [me, kim],
        roles: [],
        channels: [{ id: "ch1", name: "general", topic: null, type: "TEXT", position: 0 }],
      },
    ],
    communitiesLoaded: true,
    refreshCommunities: vi.fn(),
  }),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me }) }));
vi.mock("../context/WsContext", () => ({ useWs: () => ws }));
vi.mock("../api", () => ({
  listChannelMessages: () => live.pending ?? Promise.resolve([]),
  markChannelRead: () => Promise.resolve(),
  listEmoticons: () => Promise.resolve({ personal: [], saved: [], community: [] }),
  MESSAGE_PAGE_SIZE: 50,
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  clearHistoryCache();
  cleanup();
  live.handlers = {};
  live.pending = null;
});

describe("a message that arrives while the channel's history is still loading", () => {
  it("is still there once the history, which does not hold it, has loaded", async () => {
    let answer: (page: unknown[]) => void = () => {};
    live.pending = new Promise((resolve) => (answer = resolve));
    render(
      <MemoryRouter initialEntries={["/communities/C1/ch1"]}>
        <Routes>
          <Route path="/communities/:communityId/:channelId?" element={<CommunityPage />} />
        </Routes>
      </MemoryRouter>
    );

    act(() => live.handlers["message:created"]({ channelId: "ch1", message: message("m2", "arrived mid-load") }));
    await act(async () => answer([message("m1", "from the history")]));

    expect(await screen.findByText("from the history")).toBeTruthy();
    expect(screen.getByText("arrived mid-load")).toBeTruthy();
  });
});
