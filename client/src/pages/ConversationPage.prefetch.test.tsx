import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import { clearHistoryCache } from "../lib/messageCache";
import ConversationPage from "./ConversationPage";

// The same as CommunityPage.prefetch.test.tsx, for a conversation: its messages are asked for at the start of the page load (lib/bootPrefetch.ts, #249).

const kim = { id: "u2", identity: "@kim:chat.example", username: "kim", displayName: "Kim", avatarUrl: null, bio: null, presence: { status: "ONLINE", customStatus: null, lastSeenAt: null } } as unknown as PublicUser;
const me = { ...kim, id: "me", identity: "@me:chat.example", username: "me", displayName: "Me" } as PublicUser;
const message = (id: string, content: string) => ({ id, sender: kim, content, invite: null, emoticons: [], attachments: [], replyTo: null, reactions: [], embeds: [], createdAt: "2026-10-29T10:00:00Z", editedAt: null, deletedAt: null }) as unknown as Message;

const live = vi.hoisted(() => ({ asked: [] as string[], prefetched: new Map<string, Promise<unknown>>() }));
vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({ conversations: [{ id: "c1", type: "DM", title: null, members: [me, kim], unread: false }], refreshConversations: vi.fn() }),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me }) }));
vi.mock("../context/WsContext", () => ({ useWs: () => ({ subscribe: () => () => {} }) }));
vi.mock("../api", () => ({
  listMessages: (id: string) => {
    live.asked.push(id);
    return Promise.resolve([message("own", "asked for by the page")]);
  },
  markConversationRead: () => Promise.resolve(),
  listEmoticons: () => Promise.resolve({ personal: [], saved: [], community: [] }),
  MESSAGE_PAGE_SIZE: 50,
}));
vi.mock("../lib/bootPrefetch", () => ({
  PREFETCH_KEYS: { conversationMessages: (id: string) => `conversation:${id}` },
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
    <MemoryRouter initialEntries={["/dm/c1"]}>
      <Routes>
        <Route path="/dm/:conversationId" element={<ConversationPage />} />
      </Routes>
    </MemoryRouter>
  );

describe("the conversation's messages at the start of the page", () => {
  it("are the ones asked for at the start, and the page does not ask for them again", async () => {
    live.prefetched.set("conversation:c1", Promise.resolve([message("early", "asked for at the start")]));

    open();
    await act(async () => undefined);

    expect(screen.getByText("asked for at the start")).toBeTruthy();
    expect(live.asked).toEqual([]);
  });

  it("are asked for by the page when nothing was asked for at the start, or it was for another conversation", async () => {
    live.prefetched.set("conversation:other", Promise.resolve([message("early", "another conversation's words")]));

    open();
    await act(async () => undefined);

    expect(screen.getByText("asked for by the page")).toBeTruthy();
    expect(screen.queryByText("another conversation's words")).toBeNull();
    expect(live.asked).toEqual(["c1"]);
  });
});
