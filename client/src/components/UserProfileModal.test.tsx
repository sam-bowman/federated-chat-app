import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community, PublicUser, UserProfile } from "../api";
import { ApiError } from "../api/client";
import UserProfileModal from "./UserProfileModal";

const api = vi.hoisted(() => ({
  getUserProfile: vi.fn(),
  createConversation: vi.fn(),
  sendFriendRequest: vi.fn(),
  removeFriend: vi.fn(),
  acceptFriendRequest: vi.fn(),
  blockUser: vi.fn(),
  unblockUser: vi.fn(),
  kickMember: vi.fn(),
  banMember: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), ...api }));

const app = vi.hoisted(() => ({
  communities: [] as unknown[],
  refreshConversations: vi.fn(),
  refreshFriends: vi.fn(),
  refreshRequests: vi.fn(),
  refreshCommunities: vi.fn(),
}));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => app }));

const me = { id: "me", identity: "@me:chat.example", username: "me", displayName: "Me" };
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: me }) }));

function person(over: Partial<PublicUser> = {}): PublicUser {
  return {
    id: "u2",
    identity: "@kim:chat.example",
    username: "kim",
    displayName: "Kim",
    avatarUrl: null,
    bio: null,
    pronouns: null,
    accentColor: null,
    presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
    ...over,
  };
}

function profile(over: { user?: Partial<PublicUser>; relationship?: Partial<UserProfile["relationship"]>; rest?: Partial<UserProfile> } = {}): UserProfile {
  return {
    user: person(over.user),
    memberSince: "2025-03-15T12:00:00.000Z",
    homeServerReachable: true,
    relationship: {
      isSelf: false,
      isFriend: false,
      blockedByMe: false,
      canBlock: true,
      pendingRequest: null,
      ...over.relationship,
    },
    ...over.rest,
  };
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderModal(user: PublicUser = person(), communityId?: string, onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <UserProfileModal user={user} communityId={communityId} onClose={onClose} />
      <Where />
    </MemoryRouter>
  );
  return { onClose };
}

beforeEach(() => {
  api.getUserProfile.mockReset().mockResolvedValue(profile());
  api.createConversation.mockReset().mockResolvedValue({ id: "conv1" });
  for (const name of ["sendFriendRequest", "removeFriend", "acceptFriendRequest", "blockUser", "unblockUser", "kickMember", "banMember"] as const) {
    api[name].mockReset().mockResolvedValue({});
  }
  app.communities = [];
  for (const fn of [app.refreshConversations, app.refreshFriends, app.refreshRequests, app.refreshCommunities]) fn.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

const loaded = () => screen.findByText(/Member since/);

describe("the profile dialog", () => {
  it("shows what the page already knew straight away, then the full profile", async () => {
    api.getUserProfile.mockReturnValue(new Promise(() => {})); // never answers
    renderModal(person({ displayName: "Kim", bio: "Cached bio" }));

    expect(screen.getByRole("dialog", { name: "Profile" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Kim" })).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("asks for the profile by the person's id and shows the fields, joined date and relationship-less card", async () => {
    api.getUserProfile.mockResolvedValue(profile({ user: { bio: "I like maps", pronouns: "she/her", accentColor: "#e0a030" } }));
    renderModal(person({ bio: "stale" }));

    await loaded();

    expect(api.getUserProfile).toHaveBeenCalledWith("u2");
    expect(screen.getByText("I like maps")).toBeTruthy();
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("she/her")).toBeTruthy();
  });

  describe("your own profile", () => {
    it("offers only Edit profile, which goes to Settings and closes the dialog", async () => {
      api.getUserProfile.mockResolvedValue(profile({ user: { id: "me" }, relationship: { isSelf: true, canBlock: false } }));
      const { onClose } = renderModal(person({ id: "me" }));
      await loaded();

      expect(screen.queryByRole("button", { name: "Message" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));

      expect(screen.getByTestId("where").textContent).toBe("/settings");
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("someone else", () => {
    it("opens a direct message with Message, and goes to it", async () => {
      const { onClose } = renderModal();
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Message" }));

      await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/dm/conv1"));
      expect(api.createConversation).toHaveBeenCalledWith("DM", ["@kim:chat.example"]);
      expect(app.refreshConversations).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it("says so when a conversation cannot be opened, and stays", async () => {
      api.createConversation.mockRejectedValue(new ApiError(403, { error: "blocked" }));
      const { onClose } = renderModal();
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Message" }));

      expect((await screen.findByRole("alert")).textContent).toContain("Couldn't open a conversation");
      expect(onClose).not.toHaveBeenCalled();
    });

    it("sends a friend request by identity, so it works for someone on another server too", async () => {
      api.getUserProfile.mockResolvedValue(profile({ user: { identity: "@kim:other.example" } }));
      renderModal(person({ identity: "@kim:other.example" }));
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

      await waitFor(() => expect(api.sendFriendRequest).toHaveBeenCalledWith("@kim:other.example"));
      expect(app.refreshRequests).toHaveBeenCalled();
    });

    it("reads the profile again after an action, so the buttons change", async () => {
      renderModal();
      await loaded();
      api.getUserProfile.mockResolvedValue(profile({ relationship: { pendingRequest: { id: "r1", direction: "outgoing" } } }));

      fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

      expect((await screen.findByRole("button", { name: "Request sent" })) as HTMLButtonElement).toHaveProperty("disabled", true);
      expect(api.getUserProfile).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("button", { name: "Add friend" })).toBeNull();
    });

    it("offers Remove friend to a friend, by id", async () => {
      api.getUserProfile.mockResolvedValue(profile({ relationship: { isFriend: true } }));
      renderModal();
      await loaded();

      fireEvent.click(await screen.findByRole("button", { name: "Remove friend" }));

      await waitFor(() => expect(api.removeFriend).toHaveBeenCalledWith("u2"));
      expect(screen.queryByRole("button", { name: "Add friend" })).toBeNull();
    });

    it("offers to accept a request they sent you", async () => {
      api.getUserProfile.mockResolvedValue(profile({ relationship: { pendingRequest: { id: "r9", direction: "incoming" } } }));
      renderModal();
      await loaded();

      fireEvent.click(await screen.findByRole("button", { name: "Accept friend request" }));

      await waitFor(() => expect(api.acceptFriendRequest).toHaveBeenCalledWith("r9"));
    });

    it("asks before blocking, and blocks by username, not by what was clicked", async () => {
      renderModal();
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Block" }));
      expect(api.blockUser).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Block user" })).toBeTruthy();
      fireEvent.click(screen.getAllByRole("button", { name: "Block" }).at(-1)!);

      await waitFor(() => expect(api.blockUser).toHaveBeenCalledWith("kim"));
    });

    it("does not block when the question is cancelled", async () => {
      renderModal();
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Block" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(api.blockUser).not.toHaveBeenCalled();
    });

    it("offers no Block for someone on another server, where blocking is not built", async () => {
      api.getUserProfile.mockResolvedValue(profile({ relationship: { canBlock: false } }));
      renderModal();
      await loaded();

      expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
      expect(screen.getByRole("button", { name: "Message" })).toBeTruthy();
    });

    it("offers only Unblock to someone you blocked", async () => {
      api.getUserProfile.mockResolvedValue(profile({ relationship: { blockedByMe: true } }));
      renderModal();
      await loaded();

      expect(screen.queryByRole("button", { name: "Message" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Add friend" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Unblock" }));

      await waitFor(() => expect(api.unblockUser).toHaveBeenCalledWith("u2"));
    });

    it("says so when an action fails", async () => {
      api.sendFriendRequest.mockRejectedValue(new ApiError(409, { error: "request_already_pending" }));
      renderModal();
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

      expect((await screen.findByRole("alert")).textContent).toContain("Couldn't send the request");
    });
  });

  describe("when the profile cannot be loaded", () => {
    it("says there is no profile for you if the server answers 404 (they blocked you, or are gone), and offers no actions", async () => {
      api.getUserProfile.mockRejectedValue(new ApiError(404, { error: "not_found" }));
      renderModal();

      expect(await screen.findByText("This profile isn't available.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Message" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Add friend" })).toBeNull();
    });

    it("keeps showing the card it had, with a note, if the request fails for another reason", async () => {
      api.getUserProfile.mockRejectedValue(new Error("network"));
      renderModal(person({ displayName: "Kim", bio: "Cached bio" }));

      expect(await screen.findByText("Couldn't load the full profile.")).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Kim" })).toBeTruthy();
      expect(screen.getByText("Cached bio")).toBeTruthy();
    });

    it("says when the person's own server could not be reached, so what is shown may be old", async () => {
      api.getUserProfile.mockResolvedValue(profile({ rest: { homeServerReachable: false, memberSince: null } }));
      renderModal();

      expect(await screen.findByText(/server couldn't be reached/)).toBeTruthy();
      // the actions still work from the cached copy
      expect(screen.getByRole("button", { name: "Message" })).toBeTruthy();
    });

    it("does not set state after it was closed while still loading", async () => {
      let answer!: (value: UserProfile) => void;
      api.getUserProfile.mockReturnValue(new Promise<UserProfile>((resolve) => (answer = resolve)));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      render(
        <MemoryRouter>
          <UserProfileModal user={person()} onClose={() => {}} />
        </MemoryRouter>
      );
      cleanup();

      answer(profile());
      await Promise.resolve();

      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });
  });

  describe("opened from a community", () => {
    const community = (viewerPermissions = "0") =>
      ({
        id: "c1",
        name: "Book Club",
        owner: { id: "boss", identity: "@boss:chat.example" },
        roles: [
          { id: "everyone", name: "@everyone", color: null, position: 0, permissions: "0", isDefault: true },
          { id: "cart", name: "Cartographer", color: "#e0a030", position: 1, permissions: "0", isDefault: false },
          { id: "mod", name: "Moderator", color: null, position: 2, permissions: viewerPermissions, isDefault: false },
        ],
        members: [
          { ...me, roleIds: ["mod"], roles: [] },
          { ...person(), roleIds: ["cart"], roles: [] },
          { id: "boss", identity: "@boss:chat.example", username: "boss", displayName: "Boss", roleIds: [], roles: [] },
        ],
      }) as unknown as Community;

    // KICK_MEMBERS is bit 4, BAN_MEMBERS bit 5.
    const KICK = String(1 << 4);
    const BAN = String(1 << 5);

    it("shows their roles there, leaving out the role everyone has", async () => {
      app.communities = [community()];
      renderModal(person(), "c1");
      await loaded();

      const roles = screen.getByRole("list", { name: "Roles" });
      expect([...roles.children].map((li) => li.textContent)).toEqual(["Cartographer"]);
    });

    it("shows Owner for the owner", async () => {
      app.communities = [community()];
      api.getUserProfile.mockResolvedValue(profile({ user: { id: "boss", username: "boss", displayName: "Boss", identity: "@boss:chat.example" } }));
      renderModal(person({ id: "boss", username: "boss", displayName: "Boss", identity: "@boss:chat.example" }), "c1");
      await loaded();

      expect([...screen.getByRole("list", { name: "Roles" }).children].map((li) => li.textContent)).toEqual(["Owner"]);
    });

    it("shows no roles when opened outside a community", async () => {
      app.communities = [community()];
      renderModal(person());
      await loaded();

      expect(screen.queryByRole("list", { name: "Roles" })).toBeNull();
    });

    it("offers Kick and Ban to someone allowed to, each behind a question, and calls the right endpoint", async () => {
      app.communities = [community(`${BigInt(KICK) | BigInt(BAN)}`)];
      const { onClose } = renderModal(person(), "c1");
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Kick" }));
      expect(api.kickMember).not.toHaveBeenCalled();
      fireEvent.click(screen.getAllByRole("button", { name: "Kick" }).at(-1)!);

      await waitFor(() => expect(api.kickMember).toHaveBeenCalledWith("c1", "u2"));
      expect(app.refreshCommunities).toHaveBeenCalled();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("offers only what the viewer may do", async () => {
      app.communities = [community(KICK)];
      renderModal(person(), "c1");
      await loaded();

      expect(screen.getByRole("button", { name: "Kick" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Ban" })).toBeNull();
    });

    it("offers neither to someone with no such permission", async () => {
      app.communities = [community("0")];
      renderModal(person(), "c1");
      await loaded();

      expect(screen.queryByRole("button", { name: "Kick" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Ban" })).toBeNull();
    });

    it("never offers them for the owner, or for yourself", async () => {
      app.communities = [community(`${BigInt(KICK) | BigInt(BAN)}`)];
      api.getUserProfile.mockResolvedValue(profile({ user: { id: "boss" } }));
      renderModal(person({ id: "boss", username: "boss" }), "c1");
      await loaded();
      expect(screen.queryByRole("button", { name: "Kick" })).toBeNull();
      cleanup();

      api.getUserProfile.mockResolvedValue(profile({ user: { id: "me" }, relationship: { isSelf: true } }));
      renderModal(person({ id: "me", username: "me" }), "c1");
      await loaded();
      expect(screen.queryByRole("button", { name: "Kick" })).toBeNull();
    });

    it("reports a failed kick, and stays open", async () => {
      app.communities = [community(KICK)];
      api.kickMember.mockRejectedValue(new ApiError(403, { error: "forbidden" }));
      const { onClose } = renderModal(person(), "c1");
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Kick" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Kick" }).at(-1)!);

      expect((await screen.findByRole("alert")).textContent).toContain("Couldn't kick Kim");
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

describe("the profile dialog on a private server", () => {
  const privateRefusal = () => new ApiError(403, { error: "federation_disabled" });

  it("says why when adding a friend on another server is refused, not just that it failed", async () => {
    api.sendFriendRequest.mockRejectedValue(privateRefusal());
    api.getUserProfile.mockResolvedValue(profile({ user: { identity: "@kim:far.example" } }));
    renderModal(person({ identity: "@kim:far.example" }));
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

    expect((await screen.findByRole("alert")).textContent).toBe("This server doesn't connect to other servers, so this can only be done with people on it.");
  });

  it("says why when opening a conversation is refused", async () => {
    api.createConversation.mockRejectedValue(privateRefusal());
    renderModal();
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Message" }));

    expect((await screen.findByRole("alert")).textContent).toContain("doesn't connect to other servers");
  });

  it("says plainly when their setting does not let you add them, or start a conversation", async () => {
    api.sendFriendRequest.mockRejectedValue(new ApiError(403, { error: "contact_not_allowed" }));
    renderModal();
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

    expect((await screen.findByRole("alert")).textContent).toBe("This person isn't accepting friend requests from you.");

    api.createConversation.mockRejectedValue(new ApiError(403, { error: "contact_not_allowed" }));
    fireEvent.click(screen.getByRole("button", { name: "Message" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("This person isn't accepting conversations from you."));
  });

  it("says so when only that person's server is off limits", async () => {
    api.sendFriendRequest.mockRejectedValue(new ApiError(403, { error: "federation_domain_blocked" }));
    api.getUserProfile.mockResolvedValue(profile({ user: { identity: "@kim:far.example" } }));
    renderModal(person({ identity: "@kim:far.example" }));
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

    expect((await screen.findByRole("alert")).textContent).toBe("This server doesn't connect to that server, so this can't be done.");
  });

  it("says so when opening a conversation with someone on a server that is off limits is refused", async () => {
    api.createConversation.mockRejectedValue(new ApiError(403, { error: "federation_domain_blocked" }));
    renderModal();
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Message" }));

    expect((await screen.findByRole("alert")).textContent).toContain("doesn't connect to that server");
  });

  it("keeps the ordinary message for any other failure", async () => {
    api.sendFriendRequest.mockRejectedValue(new ApiError(500, { error: "internal_error" }));
    renderModal();
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't send the request.");
  });
});
