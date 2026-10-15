import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FriendRequest, PublicUser } from "../api";
import { UserProfileContext } from "../context/userProfile";
import FriendsPage from "./FriendsPage";

const person = (username: string): PublicUser =>
  ({
    id: `id-${username}`,
    identity: `@${username}:chat.example`,
    username,
    displayName: username[0].toUpperCase() + username.slice(1),
    avatarUrl: null,
    bio: null,
    presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
  }) as PublicUser;

const friend = person("fran");
const requester = person("rhea");
const target = person("tess");
const blocked = person("bart");
const found = person("finn");

const data = vi.hoisted(() => ({ friends: [] as unknown[], incomingRequests: [] as unknown[] }));
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null } }),
}));
vi.mock("../context/AppDataContext", () => ({
  useAppData: () => ({
    friends: data.friends,
    incomingRequests: data.incomingRequests,
    refreshFriends: vi.fn(),
    refreshRequests: vi.fn(),
    refreshConversations: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({ outgoing: [] as unknown[], blocked: [] as unknown[], found: [] as unknown[] }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  searchUsers: () => Promise.resolve(api.found),
  listFriendRequests: () => Promise.resolve(api.outgoing),
  listBlocked: () => Promise.resolve(api.blocked),
}));

beforeEach(() => {
  data.friends = [friend];
  data.incomingRequests = [{ id: "r1", from: requester, to: person("me"), message: null, status: "PENDING", createdAt: "" } satisfies FriendRequest];
  api.outgoing = [{ id: "r2", from: person("me"), to: target, message: null, status: "PENDING", createdAt: "" } satisfies FriendRequest];
  api.blocked = [blocked];
  api.found = [found];
});
afterEach(cleanup);

function renderPage() {
  const openProfile = vi.fn();
  render(
    <UserProfileContext.Provider value={{ openProfile }}>
      <MemoryRouter>
        <FriendsPage />
      </MemoryRouter>
    </UserProfileContext.Provider>
  );
  return openProfile;
}

describe("people on the Friends page open their profile", () => {
  it("from a friend's picture and from their name", () => {
    const openProfile = renderPage();

    fireEvent.click(screen.getByRole("button", { name: "View Fran's profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Fran" }));

    expect(openProfile).toHaveBeenCalledTimes(2);
    expect(openProfile).toHaveBeenNthCalledWith(1, friend, { communityId: undefined });
    expect(openProfile).toHaveBeenNthCalledWith(2, friend, { communityId: undefined });
  });

  it("from an incoming request, so you can see who is asking before you accept", () => {
    const openProfile = renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Incoming/ }));

    fireEvent.click(screen.getByRole("button", { name: "Rhea" }));

    expect(openProfile).toHaveBeenCalledWith(requester, { communityId: undefined });
  });

  it("from an outgoing request", async () => {
    const openProfile = renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Outgoing \(1\)/ }));

    fireEvent.click(screen.getByRole("button", { name: "View Tess's profile" }));

    expect(openProfile).toHaveBeenCalledWith(target, { communityId: undefined });
  });

  it("from someone you blocked, where Unblock is", async () => {
    const openProfile = renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Blocked \(1\)/ }));

    fireEvent.click(screen.getByRole("button", { name: "Bart" }));

    expect(openProfile).toHaveBeenCalledWith(blocked, { communityId: undefined });
  });

  it("from a search result, before you add them", async () => {
    const openProfile = renderPage();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fin" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "View Finn's profile" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "View Finn's profile" }));

    expect(openProfile).toHaveBeenCalledWith(found, { communityId: undefined });
  });
});
