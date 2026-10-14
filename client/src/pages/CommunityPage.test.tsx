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
