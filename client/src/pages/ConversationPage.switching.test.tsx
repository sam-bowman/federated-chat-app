import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Message, PublicUser } from "../api";
import { clearHistoryCache } from "../lib/messageCache";
import ConversationPage from "./ConversationPage";

// Moving between conversations (#237): the same as for channels (CommunityPage.switching.test.tsx), since the two pages share one way of holding
// their messages. What is on screen while the other conversation's messages are on their way, what one looked at before shows, and what marking
// one read costs.

const kim = { id: "u2", identity: "@kim:chat.example", username: "kim", displayName: "Kim", avatarUrl: null, bio: null, presence: { status: "ONLINE", customStatus: null, lastSeenAt: null } } as PublicUser;
const lee = { ...kim, id: "u3", identity: "@lee:chat.example", username: "lee", displayName: "Lee" } as PublicUser;
const me = { ...kim, id: "me", identity: "@me:chat.example", username: "me", displayName: "Me" } as PublicUser;
const message = (id: string, content: string): Message => ({ id, sender: kim, content, invite: null, emoticons: [], attachments: [], replyTo: null, reactions: [], editedAt: null, deletedAt: null, createdAt: "2026-10-15T12:00:00.000Z" }) as Message;

const live = vi.hoisted(() => ({
  waiting: {} as Record<string, ((page: unknown[]) => void)[]>,
  requested: [] as string[],
  unread: { c1: false, c2: false } as Record<string, boolean>,
  refreshConversations: undefined as unknown as Mock<() => void>,
  markRead: undefined as unknown as Mock<(id: string) => Promise<void>>,
}));
vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({
    conversations: [
      { id: "c1", type: "DM", title: null, members: [me, kim], unread: live.unread.c1 },
      { id: "c2", type: "DM", title: null, members: [me, lee], unread: live.unread.c2 },
    ],
    refreshConversations: live.refreshConversations,
  }),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me }) }));
vi.mock("../context/WsContext", () => ({ useWs: () => ({ subscribe: () => () => {} }) }));
vi.mock("../api", () => ({
  listMessages: (id: string) =>
    new Promise((resolve) => {
      live.requested.push(id);
      (live.waiting[id] ??= []).push(resolve);
    }),
  markConversationRead: (id: string) => live.markRead(id),
  listEmoticons: () => Promise.resolve({ personal: [], saved: [], community: [] }),
  MESSAGE_PAGE_SIZE: 50,
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  clearHistoryCache();
  live.waiting = {};
  live.requested = [];
  live.unread = { c1: false, c2: false };
  live.refreshConversations = vi.fn();
  live.markRead = vi.fn(() => Promise.resolve());
});
afterEach(cleanup);

const answer = (conversation: string, page: Message[]) => act(async () => live.waiting[conversation].shift()?.(page));
const go = (to: string) => act(async () => void fireEvent.click(screen.getByRole("link", { name: to })));

function open() {
  render(
    <MemoryRouter initialEntries={["/dm/c1"]}>
      <Link to="/dm/c1">to kim</Link>
      <Link to="/dm/c2">to lee</Link>
      <Routes>
        <Route path="/dm/:conversationId" element={<ConversationPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("moving to another conversation", () => {
  it("shows none of the old conversation's messages, and does not say there are none, while the new one's are on their way", async () => {
    open();
    await answer("c1", [message("k1", "words with kim")]);
    expect(screen.getByText("words with kim")).toBeTruthy();

    await go("to lee");
    expect(screen.queryByText("words with kim")).toBeNull();
    expect(screen.queryByText("No messages yet. Say hello!")).toBeNull();
    expect(document.querySelector(".message-list")?.getAttribute("aria-busy")).toBe("true");

    await answer("c2", [message("l1", "words with lee")]);
    expect(screen.getByText("words with lee")).toBeTruthy();
    expect(screen.queryByText("words with kim")).toBeNull();
  });

  it("says there are no messages once the server has said so, and not before", async () => {
    open();
    expect(screen.queryByText("No messages yet. Say hello!")).toBeNull();
    await answer("c1", []);
    expect(screen.getByText("No messages yet. Say hello!")).toBeTruthy();
  });

  it("opens a conversation looked at before at once, and then shows what the server says now", async () => {
    open();
    await answer("c1", [message("k1", "words with kim")]);
    await go("to lee");
    await answer("c2", [message("l1", "words with lee")]);

    await go("to kim");
    expect(screen.getByText("words with kim")).toBeTruthy();
    expect(screen.queryByText("words with lee")).toBeNull();
    await answer("c1", [message("k1", "kim edited"), message("k2", "kim new")]);
    expect(screen.queryByText("words with kim")).toBeNull();
    expect(screen.getByText("kim edited")).toBeTruthy();
    expect(screen.getByText("kim new")).toBeTruthy();
    expect(live.requested).toEqual(["c1", "c2", "c1"]);
  });

  it("does not show a message from a conversation that was left while its answer was on its way", async () => {
    open();
    await go("to lee");
    await answer("c1", [message("k1", "late kim")]);
    expect(screen.queryByText("late kim")).toBeNull();
    await answer("c2", [message("l1", "words with lee")]);
    expect(screen.queryByText("late kim")).toBeNull();
  });
});

describe("marking a conversation read", () => {
  it("asks for the conversations again only when it was unread", async () => {
    live.unread = { c1: true, c2: false };
    open();
    await act(async () => {});
    expect(live.markRead).toHaveBeenCalledWith("c1");
    expect(live.refreshConversations).toHaveBeenCalledTimes(1);
    await go("to lee");
    await act(async () => {});
    expect(live.markRead).toHaveBeenCalledWith("c2");
    expect(live.refreshConversations).toHaveBeenCalledTimes(1);
  });

  it("still tells the server it was read, whether or not it was unread", async () => {
    open();
    await act(async () => {});
    expect(live.markRead).toHaveBeenCalledTimes(1);
    expect(live.refreshConversations).not.toHaveBeenCalled();
  });
});
