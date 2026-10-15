import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "../api";
import { resetFederationState, setFederationEnabled } from "../lib/federation";
import FriendsPage from "./FriendsPage";

const mocks = vi.hoisted(() => ({
  searchUsers: vi.fn(),
  sendFriendRequest: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null } }),
}));
vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({
    friends: [],
    incomingRequests: [],
    refreshFriends: vi.fn(),
    refreshRequests: vi.fn(),
    refreshConversations: vi.fn(),
  }),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  searchUsers: mocks.searchUsers,
  sendFriendRequest: mocks.sendFriendRequest,
  listFriendRequests: () => Promise.resolve([]),
  listBlocked: () => Promise.resolve([]),
}));

function person(username: string): PublicUser {
  return {
    id: `id-${username}`,
    identity: `@${username}:chat.example`,
    username,
    displayName: username[0].toUpperCase() + username.slice(1),
    avatarUrl: null,
    bio: null,
    presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
  } as PublicUser;
}

beforeEach(() => {
  mocks.searchUsers.mockReset().mockResolvedValue([person("bob"), person("bobby")]);
  mocks.sendFriendRequest.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

function renderPage() {
  render(
    <MemoryRouter>
      <FriendsPage />
    </MemoryRouter>
  );
  return screen.getByRole("combobox");
}

async function searchFor(box: HTMLElement, text: string) {
  fireEvent.change(box, { target: { value: text } });
  await screen.findByText(/Bob · @bob:chat.example/);
}

describe("the add-a-friend search results", () => {
  it("closes when you click anywhere outside the search", async () => {
    const box = renderPage();
    await searchFor(box, "bo");

    fireEvent.mouseDown(document.body);

    expect(screen.queryByText(/Bob · @bob:chat.example/)).toBeNull();
  });

  it("stays open when you click inside the results", async () => {
    const box = renderPage();
    await searchFor(box, "bo");

    fireEvent.mouseDown(screen.getByText(/Bobby · @bobby:chat.example/));

    expect(screen.queryByText(/Bobby · @bobby:chat.example/)).not.toBeNull();
  });

  it("closes on Escape, and opens again when you type or focus the box", async () => {
    const box = renderPage();
    await searchFor(box, "bo");

    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByText(/Bob · @bob:chat.example/)).toBeNull();

    fireEvent.focus(box);
    expect(screen.queryByText(/Bob · @bob:chat.example/)).not.toBeNull();
  });

  // The reported bug: choosing someone already added left their row stuck over the box, because the
  // list was only cleared when the request succeeded.
  it.each([
    ["already_friends", "You're already friends."],
    ["request_already_pending", /already a pending request/],
    ["blocked", /can't send a request/],
    ["something_else", "Couldn't send request."],
  ])("closes the list when adding fails with %s", async (code, message) => {
    mocks.sendFriendRequest.mockRejectedValue({ body: { error: code } });
    const box = renderPage();
    await searchFor(box, "bo");

    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);

    await screen.findByText(message);
    expect(screen.queryByText(/Bob · @bob:chat.example/)).toBeNull();
  });

  it("closes the list and clears the box when the request is sent", async () => {
    const box = renderPage();
    await searchFor(box, "bo");

    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);

    await screen.findByText("Friend request sent to bob.");
    expect(mocks.sendFriendRequest).toHaveBeenCalledWith("bob");
    expect(screen.queryByText(/Bob · @bob:chat.example/)).toBeNull();
    expect((box as HTMLInputElement).value).toBe("");
  });

  it("moves through the results with the arrow keys and adds the highlighted one on Enter", async () => {
    const box = renderPage();
    await searchFor(box, "bo");

    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(mocks.sendFriendRequest).toHaveBeenCalledWith("bobby"));
  });

  it("wraps from the first result back to the last with ArrowUp", async () => {
    const box = renderPage();
    await searchFor(box, "bo");

    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(mocks.sendFriendRequest).toHaveBeenCalledWith("bobby"));
  });

  it("sends what is typed when Enter is pressed with no result highlighted", async () => {
    const box = renderPage();
    await searchFor(box, "bo");

    fireEvent.submit(box.closest("form")!);

    await waitFor(() => expect(mocks.sendFriendRequest).toHaveBeenCalledWith("bo"));
  });

  // A slow answer for an old query must not repopulate a list the user already closed by clearing the box.
  it("ignores a search answer that arrives after the box was cleared", async () => {
    let answer: (users: PublicUser[]) => void = () => {};
    mocks.searchUsers.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const box = renderPage();

    fireEvent.change(box, { target: { value: "bo" } });
    await waitFor(() => expect(mocks.searchUsers).toHaveBeenCalled());
    fireEvent.change(box, { target: { value: "" } });
    answer([person("bob")]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText(/Bob · @bob:chat.example/)).toBeNull();
  });
});

describe("the add-a-friend box on a private server", () => {
  const typeAndSend = (box: HTMLElement, text: string) => {
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  };
  afterEach(() => resetFederationState());

  it("offers people on this server only, in its hint", () => {
    setFederationEnabled(false);
    const box = renderPage();

    expect(box.getAttribute("placeholder")).toBe("Add a friend: alex (this server only)…");
  });

  it("still offers other servers when federation is on", () => {
    const box = renderPage();

    expect(box.getAttribute("placeholder")).toContain("@alex:theirserver.com for someone on another server");
  });

  it.each(["@dave:far.example", "dave:far.example", "@dave:far.example:8443"])("says why, without asking the server, when %s is on another server", async (who) => {
    setFederationEnabled(false);
    const box = renderPage();

    typeAndSend(box, who);

    expect(await screen.findByText(/doesn't connect to other servers/)).toBeTruthy();
    expect(mocks.sendFriendRequest).not.toHaveBeenCalled();
  });

  it.each(["bob", "@bob:chat.example", "bob:CHAT.example"])("still sends a request to %s, who is on this server", async (who) => {
    setFederationEnabled(false);
    const box = renderPage();

    typeAndSend(box, who);

    // The box lowercases what is typed.
    await waitFor(() => expect(mocks.sendFriendRequest).toHaveBeenCalledWith(who.toLowerCase()));
  });

  it("sends a request to someone on another server when federation is on", async () => {
    const box = renderPage();

    typeAndSend(box, "@dave:far.example");

    await waitFor(() => expect(mocks.sendFriendRequest).toHaveBeenCalledWith("@dave:far.example"));
  });

  it("says the same if the server refuses (it was turned private since the page loaded)", async () => {
    mocks.sendFriendRequest.mockRejectedValue({ body: { error: "federation_disabled" } });
    const box = renderPage();

    typeAndSend(box, "@dave:far.example");

    expect(await screen.findByText(/doesn't connect to other servers/)).toBeTruthy();
  });
});
