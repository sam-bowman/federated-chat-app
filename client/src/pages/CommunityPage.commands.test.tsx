import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommunityPage from "./CommunityPage";

const appData = vi.hoisted(() => ({ value: { communities: [] as unknown[], communitiesLoaded: false, refreshCommunities: vi.fn() } }));
const mocks = vi.hoisted(() => ({ list: vi.fn(), run: vi.fn() }));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => appData.value }));
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u1", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null } }),
}));
vi.mock("../context/WsContext", () => ({ useWs: () => ({ subscribe: () => () => {}, sendTyping: vi.fn() }) }));
vi.mock("../api", () => ({
  listChannelMessages: () => Promise.resolve([]),
  markChannelRead: () => Promise.resolve(),
  listEmoticons: () => Promise.resolve({ personal: [], saved: [], community: [] }),
  listCommunityCommands: mocks.list,
  runCommand: mocks.run,
  getOpenReportCount: vi.fn().mockResolvedValue({ open: 0 }),
  mediaUrl: (p: string) => p,
  MESSAGE_PAGE_SIZE: 50,
}));

const me = { id: "u1", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null };
const robo = { id: "robo", identity: "@robo:chat.example", username: "robo", displayName: "Robo", avatarUrl: null, isBot: true };
const ping = { id: "cmd1", name: "ping", description: "Say pong", options: [], bot: robo, botOnline: true };

beforeEach(() => {
  mocks.list.mockResolvedValue({ commands: [ping], canUse: true });
  mocks.run.mockResolvedValue({ interaction: { id: "int1" } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  appData.value = { communities: [], communitiesLoaded: false, refreshCommunities: vi.fn() };
});

function open(homeserverDomain: string) {
  appData.value = {
    communities: [{ id: "C1", name: "Book Club", homeserverDomain, owner: me, members: [me, robo], roles: [], channels: [{ id: "ch1", name: "general", topic: null, type: "TEXT", position: 0 }] }],
    communitiesLoaded: true,
    refreshCommunities: vi.fn(),
  };
  render(
    <MemoryRouter initialEntries={["/communities/C1/ch1"]}>
      <Routes>
        <Route path="/communities/:communityId/:channelId?" element={<CommunityPage />} />
      </Routes>
    </MemoryRouter>
  );
  return screen.getByPlaceholderText("Message #general") as HTMLInputElement;
}

describe("CommunityPage: slash commands", () => {
  it("runs a command from the box and says it is waiting for the bot until it answers", async () => {
    const input = open("chat.example");
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith("C1"));
    // The first answer has to be in before the list can open.
    await waitFor(() => {
      fireEvent.change(input, { target: { value: "/pi" } });
      expect(screen.queryByRole("listbox", { name: "Command suggestions" })).not.toBeNull();
    });
    fireEvent.keyDown(input, { key: "Enter" });
    const form = screen.getByRole("form", { name: "Run /ping" });
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith("ch1", "cmd1", {}));
    expect(await screen.findByText("Waiting for Robo…")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("form", { name: "Run /ping" })).toBeNull());
  });

  it("offers no commands, and asks for none, in a community that lives on another server", async () => {
    const input = open("other.example");
    fireEvent.change(input, { target: { value: "/" } });
    await Promise.resolve();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "Command suggestions" })).toBeNull();
  });
});
