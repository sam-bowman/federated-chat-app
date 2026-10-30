import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Message, PublicUser } from "../api";
import { clearHistoryCache } from "../lib/messageCache";
import CommunityPage from "./CommunityPage";

// Moving between channels (#237): what is on screen while the other channel's messages are on their way, what a channel looked at before shows,
// and what marking a channel read costs. The page is not rebuilt when only the channel changes, which is what used to leave the old channel's
// messages under the new channel's name.

const kim = { id: "u2", identity: "@kim:chat.example", username: "kim", displayName: "Kim", avatarUrl: null, bio: null, presence: { status: "ONLINE", customStatus: null, lastSeenAt: null } } as PublicUser;
const me = { ...kim, id: "me", identity: "@me:chat.example", username: "me", displayName: "Me" } as PublicUser;
const message = (id: string, content: string): Message => ({ id, sender: kim, content, invite: null, emoticons: [], attachments: [], replyTo: null, reactions: [], editedAt: null, deletedAt: null, createdAt: "2026-10-15T12:00:00.000Z" }) as Message;

const live = vi.hoisted(() => ({
  /** Each request for a channel's history waits here until the test answers it. */
  waiting: {} as Record<string, ((page: unknown[]) => void)[]>,
  requested: [] as string[],
  handlers: {} as Record<string, (payload: unknown) => void>,
  unread: { ch1: false, ch2: false } as Record<string, boolean>,
  refreshCommunities: undefined as unknown as Mock<() => void>,
  markRead: undefined as unknown as Mock<(id: string) => Promise<void>>,
}));
vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({
    communities: ["C1", "C2"].map((id, i) => ({
      id,
      name: i === 0 ? "Alpha" : "Bravo",
      homeserverDomain: "chat.example",
      owner: me,
      members: [me, kim],
      roles: [],
      channels: [{ id: `ch${i + 1}`, name: "general", topic: null, type: "TEXT", position: 0, unread: live.unread[`ch${i + 1}`] }],
    })),
    communitiesLoaded: true,
    refreshCommunities: live.refreshCommunities,
  }),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me }) }));
vi.mock("../context/WsContext", () => ({
  useWs: () => ({
    subscribe: (type: string, handler: (payload: unknown) => void) => {
      live.handlers[type] = handler;
      return () => {};
    },
  }),
}));
vi.mock("../api", () => ({
  listChannelMessages: (id: string) =>
    new Promise((resolve) => {
      live.requested.push(id);
      (live.waiting[id] ??= []).push(resolve);
    }),
  markChannelRead: (id: string) => live.markRead(id),
  listEmoticons: () => Promise.resolve({ personal: [], saved: [], community: [] }),
  getOpenReportCount: () => Promise.resolve({ open: 0 }),
  MESSAGE_PAGE_SIZE: 50,
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  clearHistoryCache();
  live.waiting = {};
  live.requested = [];
  live.handlers = {};
  live.unread = { ch1: false, ch2: false };
  live.refreshCommunities = vi.fn();
  live.markRead = vi.fn(() => Promise.resolve());
});
afterEach(cleanup);

const answer = (channel: string, page: Message[]) => act(async () => live.waiting[channel].shift()?.(page));
const go = (to: string) => act(async () => void fireEvent.click(screen.getByRole("link", { name: to })));

function open() {
  render(
    <MemoryRouter initialEntries={["/communities/C1/ch1"]}>
      <Link to="/communities/C1/ch1">to alpha</Link>
      <Link to="/communities/C2/ch2">to bravo</Link>
      <Routes>
        <Route path="/communities/:communityId/:channelId?" element={<CommunityPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("moving to another channel", () => {
  it("shows none of the old channel's messages, and does not say there are none, while the new channel's are on their way", async () => {
    open();
    await answer("ch1", [message("a1", "alpha words")]);
    expect(screen.getByText("alpha words")).toBeTruthy();

    await go("to bravo");
    expect(screen.queryByText("alpha words")).toBeNull();
    expect(screen.queryByText("No messages yet. Say hello!")).toBeNull();
    expect(document.querySelector(".message-list")?.getAttribute("aria-busy")).toBe("true");

    await answer("ch2", [message("b1", "bravo words")]);
    expect(screen.getByText("bravo words")).toBeTruthy();
    expect(screen.queryByText("alpha words")).toBeNull();
    expect(document.querySelector(".message-list")?.getAttribute("aria-busy")).toBeNull();
  });

  it("says there are no messages once the server has said so, and not before", async () => {
    open();
    expect(screen.queryByText("No messages yet. Say hello!")).toBeNull();
    await answer("ch1", []);
    expect(screen.getByText("No messages yet. Say hello!")).toBeTruthy();
  });

  it("opens a channel looked at before at once, and then shows what the server says now", async () => {
    open();
    await answer("ch1", [message("a1", "alpha words")]);
    await go("to bravo");
    await answer("ch2", [message("b1", "bravo words")]);

    await go("to alpha");
    // Before the server has answered:
    expect(screen.getByText("alpha words")).toBeTruthy();
    expect(screen.queryByText("bravo words")).toBeNull();
    // and then what it says now: edited, with a new message.
    await answer("ch1", [message("a1", "alpha edited"), message("a2", "alpha new")]);
    expect(screen.queryByText("alpha words")).toBeNull();
    expect(screen.getByText("alpha edited")).toBeTruthy();
    expect(screen.getByText("alpha new")).toBeTruthy();
  });

  it("asks the server for the channel every time it is opened, even when it has it kept", async () => {
    open();
    await answer("ch1", [message("a1", "alpha words")]);
    await go("to bravo");
    await answer("ch2", [message("b1", "bravo words")]);
    await go("to alpha");
    expect(live.requested).toEqual(["ch1", "ch2", "ch1"]);
  });

  it("does not show a message from a channel that was left while its answer was on its way", async () => {
    open();
    await go("to bravo");
    await answer("ch1", [message("a1", "late alpha")]);
    expect(screen.queryByText("late alpha")).toBeNull();
    await answer("ch2", [message("b1", "bravo words")]);
    expect(screen.getByText("bravo words")).toBeTruthy();
    expect(screen.queryByText("late alpha")).toBeNull();
  });
});

describe("who is typing", () => {
  it("is not carried over to the next channel: someone typing in one is not typing in the other", async () => {
    open();
    await answer("ch1", [message("a1", "alpha words")]);
    act(() => live.handlers["typing"]({ channelId: "ch1", userId: "u2" }));
    expect(screen.getByText("Kim is typing…")).toBeTruthy();
    await go("to bravo");
    expect(screen.queryByText("Kim is typing…")).toBeNull();
  });
});

describe("marking a channel read", () => {
  it("asks for the communities again only when the channel was unread, since otherwise nothing it shows changes", async () => {
    live.unread = { ch1: true, ch2: false };
    open();
    await act(async () => {});
    expect(live.markRead).toHaveBeenCalledWith("ch1");
    expect(live.refreshCommunities).toHaveBeenCalledTimes(1);

    await go("to bravo");
    await act(async () => {});
    expect(live.markRead).toHaveBeenCalledWith("ch2");
    expect(live.refreshCommunities).toHaveBeenCalledTimes(1); // ch2 was not unread
  });

  it("still tells the server it was read, whether or not it was unread", async () => {
    open();
    await act(async () => {});
    expect(live.markRead).toHaveBeenCalledTimes(1);
    expect(live.refreshCommunities).not.toHaveBeenCalled();
  });
});
