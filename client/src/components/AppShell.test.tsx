import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppShell from "./AppShell";

const me = { id: "u1", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null };

const appData = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => appData.value }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me, logout: vi.fn() }) }));
// The rail and the footer have their own tests and need contexts of their own.
vi.mock("./CommunityRail", () => ({ default: () => null }));
vi.mock("./AccountFooter", () => ({ default: () => null }));

afterEach(cleanup);

function renderCommunity(channels: { id: string; name: string; topic: string | null }[]) {
  appData.value = {
    conversations: [],
    incomingRequests: [],
    communities: [
      {
        id: "C1",
        name: "Book Club",
        owner: me,
        members: [me],
        roles: [],
        channels: channels.map((c, position) => ({ ...c, type: "TEXT", position })),
      },
    ],
  };
  render(
    <MemoryRouter initialEntries={["/communities/C1/ch1"]}>
      <Routes>
        <Route path="/communities/:communityId/:channelId?" element={<AppShell />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("the channel list in the sidebar", () => {
  it("shows a channel's topic as its tooltip, and none for a channel without one", () => {
    renderCommunity([
      { id: "ch1", name: "general", topic: "What we are reading" },
      { id: "ch2", name: "random", topic: null },
      { id: "ch3", name: "blank", topic: "   " },
    ]);

    expect(screen.getByText("# general").closest("a")?.getAttribute("title")).toBe("What we are reading");
    expect(screen.getByText("# random").closest("a")?.hasAttribute("title")).toBe(false);
    expect(screen.getByText("# blank").closest("a")?.hasAttribute("title")).toBe(false);
  });
});
