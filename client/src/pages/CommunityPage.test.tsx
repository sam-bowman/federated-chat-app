import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetFederationState, setFederationEnabled } from "../lib/federation";
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
  reportContent: vi.fn().mockResolvedValue({ received: true }),
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

  it("gives the community and channel name a tooltip with all of it, since a long one is cut with an ellipsis", () => {
    openChannel(null);

    expect(screen.getByText(/Book Club · # general/).getAttribute("title")).toBe("Book Club · # general");
  });

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

describe("reporting the community (#58)", () => {
  const me = { id: "u1", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null };
  const owner = { id: "u9", identity: "@boss:chat.example", username: "boss", displayName: "Boss", avatarUrl: null };
  function open(ownerOfIt: typeof me) {
    appData.value = {
      communities: [{ id: "C1", name: "Book Club", homeserverDomain: "chat.example", owner: ownerOfIt, members: [me, owner], roles: [], channels: [{ id: "ch1", name: "general", topic: null, type: "TEXT", position: 0 }] }],
      communitiesLoaded: true,
      refreshCommunities: vi.fn(),
    };
    return renderAt("/communities/C1/ch1");
  }

  it("offers a member a Report button that opens the report for this community", () => {
    open(owner);
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(screen.getByRole("dialog", { name: "Report a community" })).toBeTruthy();
    expect(screen.getByText(/You are reporting Book Club/)).toBeTruthy();
  });

  it("says the report goes to the other server for a community that lives on one", () => {
    appData.value = {
      communities: [{ id: "C1", name: "Far Club", homeserverDomain: "far.example", owner, members: [me, owner], roles: [], channels: [{ id: "ch1", name: "general", topic: null, type: "TEXT", position: 0 }] }],
      communitiesLoaded: true,
      refreshCommunities: vi.fn(),
    };
    renderAt("/communities/C1/ch1");
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(screen.getByText(/It is sent to far\.example, where this community lives/)).toBeTruthy();
  });

  it("does not say so for one on this server", () => {
    open(owner);
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(screen.queryByText(/It is sent to/)).toBeNull();
  });

  it("offers the owner none: nobody reports their own community", () => {
    open(me);
    expect(screen.queryByRole("button", { name: "Report" })).toBeNull();
  });
});

describe("a community with a voice channel first", () => {
  const member = { id: "u1", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null };
  function openAt(path: string, channels: object[]) {
    appData.value = {
      communities: [{ id: "C1", name: "Book Club", homeserverDomain: "chat.example", owner: member, members: [member], roles: [], channels }],
      communitiesLoaded: true,
      refreshCommunities: vi.fn(),
    };
    return renderAt(path);
  }
  const lounge = { id: "v1", name: "Lounge", topic: null, type: "VOICE", position: 0 };
  const general = { id: "ch1", name: "general", topic: null, type: "TEXT", position: 1 };

  it("opens the first TEXT channel, not the voice channel at the top (it has no messages to show)", () => {
    openAt("/communities/C1", [lounge, general]);
    expect(screen.getByText(/Book Club · # general/)).not.toBeNull();
  });

  it("does not open a voice channel from its address either, but a text channel", () => {
    openAt("/communities/C1/v1", [lounge, general]);
    expect(screen.getByText(/Book Club · # general/)).not.toBeNull();
  });

  it("says there are no text channels when there are only voice channels", () => {
    openAt("/communities/C1", [lounge]);
    expect(screen.getByText("This community has no text channels yet.")).not.toBeNull();
  });
});

describe("a community on another server, when this server is private", () => {
  afterEach(() => resetFederationState());
  const member = { id: "u1", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null };
  function openCommunity(homeserverDomain: string) {
    appData.value = {
      communities: [
        {
          id: "C1",
          name: "Book Club",
          homeserverDomain,
          owner: member,
          members: [member],
          roles: [],
          channels: [{ id: "ch1", name: "general", topic: null, type: "TEXT", position: 0 }],
        },
      ],
      communitiesLoaded: true,
      refreshCommunities: vi.fn(),
    };
    return renderAt("/communities/C1/ch1");
  }
  const note = () => screen.queryByRole("note");

  it("says it can be read but nothing sent to it", () => {
    setFederationEnabled(false);
    openCommunity("far.example");

    expect(note()?.textContent).toContain("you can read what is here but not send anything to it");
  });

  it("says nothing for a community on this server", () => {
    setFederationEnabled(false);
    openCommunity("chat.example");

    expect(note()).toBeNull();
  });

  it("says nothing while this server federates", () => {
    openCommunity("far.example");

    expect(note()).toBeNull();
  });

  it("compares the server without regard to case", () => {
    setFederationEnabled(false);
    openCommunity("CHAT.example");

    expect(note()).toBeNull();
  });
});
