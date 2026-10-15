import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommunityPage from "./CommunityPage";

const appData = vi.hoisted(() => ({
  value: { communities: [] as unknown[], communitiesLoaded: false, refreshCommunities: vi.fn() },
}));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => appData.value }));
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u1", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null } }),
}));
vi.mock("../context/WsContext", () => ({ useWs: () => ({ subscribe: () => () => {} }) }));
vi.mock("../api", () => ({
  listChannelMessages: () => Promise.resolve([]),
  markChannelRead: () => Promise.resolve(),
  listEmoticons: () => Promise.resolve({ personal: [], saved: [], community: [] }),
  MESSAGE_PAGE_SIZE: 50,
}));

afterEach(() => {
  cleanup();
  appData.value = { communities: [], communitiesLoaded: false, refreshCommunities: vi.fn() };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/communities/:communityId/:channelId?" element={<CommunityPage />} />
        <Route path="/friends" element={<div>Friends page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("CommunityPage when the community is not in the list", () => {
  it("waits, showing Loading, until the list has arrived", () => {
    renderAt("/communities/GONE");
    expect(screen.getByText("Loading…")).not.toBeNull();
    expect(screen.queryByText("Friends page")).toBeNull();
  });

  // The owner deleted it (or we were removed) while this page was open: sitting on "Loading…" for ever
  // is the bug this guards.
  it("leaves for Friends once the list has loaded without it", () => {
    appData.value = { communities: [], communitiesLoaded: true, refreshCommunities: vi.fn() };
    renderAt("/communities/GONE");
    expect(screen.getByText("Friends page")).not.toBeNull();
  });
});

describe("the channel header", () => {
  const member = { id: "u1", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null };
  function openChannel(topic: string | null) {
    appData.value = {
      communities: [
        {
          id: "C1",
          name: "Book Club",
          owner: member,
          members: [member],
          roles: [],
          channels: [
            { id: "ch1", name: "general", topic, type: "TEXT", position: 0 },
            { id: "ch2", name: "random", topic: "Off topic", type: "TEXT", position: 1 },
          ],
        },
      ],
      communitiesLoaded: true,
      refreshCommunities: vi.fn(),
    };
    return renderAt("/communities/C1/ch1");
  }

  it("shows the channel's topic beside its name", () => {
    openChannel("What we are reading this month");

    expect(screen.getByText(/Book Club · # general/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "What we are reading this month" })).not.toBeNull();
  });

  it("shows no topic control when the channel has none", () => {
    openChannel(null);

    expect(screen.getByText(/Book Club · # general/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Off topic" })).toBeNull(); // another channel's topic is not shown
    expect(document.querySelector(".channel-topic")).toBeNull();
  });
});
