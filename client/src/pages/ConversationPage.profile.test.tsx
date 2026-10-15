import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "../api";
import { UserProfileContext } from "../context/userProfile";
import { resetFederationState, setFederationEnabled } from "../lib/federation";
import ConversationPage from "./ConversationPage";

const person = (id: string, displayName: string, domain = "chat.example"): PublicUser =>
  ({
    id,
    identity: `@${displayName.toLowerCase()}:${domain}`,
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
    bio: null,
    presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
  }) as PublicUser;

const me = person("me", "Me");
const kim = person("u2", "Kim");

const appData = vi.hoisted(() => ({ conversations: [] as unknown[] }));
vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({ conversations: appData.conversations, refreshConversations: vi.fn() }),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me }) }));
vi.mock("../context/WsContext", () => ({ useWs: () => ({ subscribe: () => () => {} }) }));
vi.mock("../api", () => ({
  listMessages: () => Promise.resolve([]),
  markConversationRead: () => Promise.resolve(),
  listEmoticons: () => Promise.resolve({ personal: [], saved: [], community: [] }),
  MESSAGE_PAGE_SIZE: 50,
}));

afterEach(cleanup);

function renderConversation(members: PublicUser[], type: "DM" | "GROUP" = "DM", title: string | null = null) {
  appData.conversations = [{ id: "c1", type, title, members, unread: false }];
  const openProfile = vi.fn();
  render(
    <UserProfileContext.Provider value={{ openProfile }}>
      <MemoryRouter initialEntries={["/dm/c1"]}>
        <Routes>
          <Route path="/dm/:conversationId" element={<ConversationPage />} />
        </Routes>
      </MemoryRouter>
    </UserProfileContext.Provider>
  );
  return openProfile;
}

describe("the conversation header", () => {
  it("opens the other person's profile from their name, in a direct message", () => {
    const openProfile = renderConversation([me, kim]);

    fireEvent.click(screen.getByRole("button", { name: "Kim" }));

    expect(openProfile).toHaveBeenCalledWith(kim, { communityId: undefined });
  });

  it("shows no link, only the title, for a group chat", () => {
    renderConversation([me, kim, person("u3", "Lee")], "GROUP", "Book club");

    expect(screen.getByText("Book club")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Kim" })).toBeNull();
  });

  it("shows (left) rather than a link when the other person has left", () => {
    renderConversation([me]);

    expect(screen.getByText("(left)")).toBeTruthy();
  });
});

describe("the conversation page on a private server", () => {
  afterEach(() => resetFederationState());
  const note = () => screen.queryByRole("note");

  it("says what you write to someone on another server is held, once the server is known to be private", () => {
    setFederationEnabled(false);
    renderConversation([me, person("u2", "Kim", "far.example")]);

    expect(note()?.textContent).toContain("kept and sent to the people on other servers if it connects again");
  });

  it("says nothing for a conversation with people on this server only", () => {
    setFederationEnabled(false);
    renderConversation([me, kim]);

    expect(note()).toBeNull();
  });

  it("says nothing when the server federates", () => {
    renderConversation([me, person("u2", "Kim", "far.example")]);

    expect(note()).toBeNull();
  });

  it("covers a group where only one of the members is on another server", () => {
    setFederationEnabled(false);
    renderConversation([me, kim, person("u3", "Lee", "far.example")], "GROUP", "Trio");

    expect(note()).not.toBeNull();
  });
});
