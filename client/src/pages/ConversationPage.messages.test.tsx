import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, PublicUser } from "../api";
import ConversationPage from "./ConversationPage";

const person = (id: string, displayName: string): PublicUser =>
  ({
    id,
    identity: `@${displayName.toLowerCase()}:chat.example`,
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
    bio: null,
    presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
  }) as PublicUser;

const me = person("me", "Me");
const kim = person("u2", "Kim");

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
  history: [] as unknown[],
}));
vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({
    conversations: [{ id: "c1", type: "DM", title: null, members: [me, kim], unread: false }],
    refreshConversations: vi.fn(),
  }),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me }) }));
// One `subscribe` for the life of the page, as the real context gives: a new one on every render would make the page
// subscribe afresh each time and so always read current state, which hides the very bug this file is about.
const ws = vi.hoisted(() => ({
  subscribe: (type: string, handler: (payload: unknown) => void) => {
    live.handlers[type] = handler;
    return () => {};
  },
}));
vi.mock("../context/WsContext", () => ({ useWs: () => ws }));
vi.mock("../api", () => ({
  listMessages: () => Promise.resolve(live.history),
  markConversationRead: () => Promise.resolve(),
  listEmoticons: () => Promise.resolve({ personal: [], saved: [], community: [] }),
  MESSAGE_PAGE_SIZE: 50,
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  live.handlers = {};
});

function open() {
  render(
    <MemoryRouter initialEntries={["/dm/c1"]}>
      <Routes>
        <Route path="/dm/:conversationId" element={<ConversationPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("a message that arrives live", () => {
  // Found by the end-to-end suite: after a reload, the other server's relay of a message the history had already loaded
  // drew it twice, because the duplicate check read the (still empty) list from when the page opened.
  it("is not drawn again when the history already loaded it", async () => {
    live.history = [message("m1", "already here")];
    open();
    await screen.findByText("already here");

    act(() => live.handlers["message:created"]({ conversationId: "c1", message: message("m1", "already here") }));

    expect(screen.getAllByText("already here")).toHaveLength(1);
  });

  it("is added when it is new", async () => {
    live.history = [message("m1", "already here")];
    open();
    await screen.findByText("already here");

    act(() => live.handlers["message:created"]({ conversationId: "c1", message: message("m2", "just arrived") }));

    await waitFor(() => expect(screen.getByText("just arrived")).toBeTruthy());
    expect(screen.getAllByText("already here")).toHaveLength(1);
  });

  it("is ignored when it belongs to another conversation", async () => {
    live.history = [];
    open();
    await screen.findByText(/No messages yet/i);

    act(() => live.handlers["message:created"]({ conversationId: "other", message: message("m3", "not for here") }));

    expect(screen.queryByText("not for here")).toBeNull();
  });
});
