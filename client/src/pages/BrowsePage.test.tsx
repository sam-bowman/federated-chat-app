import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryCommunity, DirectoryPerson } from "../api";
import { ApiError } from "../api/client";
import { resetFederationState, setFederationEnabled } from "../lib/federation";
import BrowsePage from "./BrowsePage";

const api = vi.hoisted(() => ({
  listDirectoryCommunities: vi.fn(),
  listDirectoryPeople: vi.fn(),
  joinCommunity: vi.fn(),
  sendFriendRequest: vi.fn(),
}));
vi.mock("../api", () => api);

const appData = vi.hoisted(() => ({ value: { communities: [] as { id: string }[], friends: [] as { identity: string }[], refreshCommunities: vi.fn() } }));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => appData.value }));

const club = (over: Partial<DirectoryCommunity> = {}): DirectoryCommunity => ({
  id: "C1",
  domain: "chat.example",
  name: "Book Club",
  description: "We read.",
  iconUrl: null,
  iconText: null,
  iconColor: null,
  memberCount: 12,
  ...over,
});
const person = (over: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  id: "P1",
  username: "rex",
  domain: "chat.example",
  displayName: "Rex",
  avatarUrl: null,
  bio: "Hello",
  ...over,
});

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/browse"]}>
      <Where />
      <Routes>
        <Route path="/browse" element={<BrowsePage />} />
        <Route path="/communities/:id" element={<div>Community page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  resetFederationState();
  appData.value = { communities: [], friends: [], refreshCommunities: vi.fn().mockResolvedValue(undefined) };
  api.listDirectoryCommunities.mockResolvedValue({ items: [club()], nextCursor: null });
  api.listDirectoryPeople.mockResolvedValue({ items: [person()], nextCursor: null });
  api.joinCommunity.mockResolvedValue({});
  api.sendFriendRequest.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const serverBox = () => screen.getByLabelText("Server to browse") as HTMLInputElement;

describe("Browse: this server's communities", () => {
  it("lists what the server lists, as text, with how many are in", async () => {
    api.listDirectoryCommunities.mockResolvedValue({
      items: [club({ name: "<img src=x onerror=alert(1)>", description: "<b>bold</b>", memberCount: 1 })],
      nextCursor: null,
    });
    renderPage();

    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(screen.getByText("<b>bold</b>")).toBeTruthy();
    expect(screen.getByText("1 member")).toBeTruthy();
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(api.listDirectoryCommunities).toHaveBeenCalledWith({ domain: null, q: "", cursor: null });
  });

  it("offers Join for one you are not in, and Open for one you are", async () => {
    appData.value.communities = [{ id: "C2" }];
    api.listDirectoryCommunities.mockResolvedValue({ items: [club(), club({ id: "C2", name: "Chess" })], nextCursor: null });
    renderPage();

    expect(await screen.findByRole("button", { name: "Join Book Club" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Join Chess" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/communities/C2");
  });

  it("joins with the community's id and server, then opens it", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Join Book Club" }));

    await waitFor(() => expect(api.joinCommunity).toHaveBeenCalledWith("C1:chat.example"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/communities/C1"));
    expect(appData.value.refreshCommunities).toHaveBeenCalled();
  });

  it("says why a join failed, on that row", async () => {
    api.joinCommunity.mockRejectedValue(new ApiError(403, { error: "invite_required" }));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Join Book Club" }));

    expect((await screen.findByRole("alert")).textContent).toContain("invite-only");
    expect(screen.getByTestId("where").textContent).toBe("/browse");
  });

  it("says when there is nothing, naming this server", async () => {
    api.listDirectoryCommunities.mockResolvedValue({ items: [], nextCursor: null });
    renderPage();

    expect(await screen.findByText("This server lists no communities yet.")).toBeTruthy();
  });

  it("searches, and says when nothing matches", async () => {
    renderPage();
    await screen.findByText("Book Club");
    api.listDirectoryCommunities.mockResolvedValue({ items: [], nextCursor: null });

    fireEvent.change(screen.getByLabelText("Search communities"), { target: { value: "  chess " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(api.listDirectoryCommunities).toHaveBeenLastCalledWith({ domain: null, q: "chess", cursor: null }));
    expect(await screen.findByText('Nothing matches "chess" on this server.')).toBeTruthy();
  });

  it("loads more, adds them below, and shows none twice", async () => {
    api.listDirectoryCommunities.mockResolvedValueOnce({ items: [club()], nextCursor: "C1" });
    renderPage();
    await screen.findByText("Book Club");
    api.listDirectoryCommunities.mockResolvedValueOnce({ items: [club(), club({ id: "C0", name: "Chess" })], nextCursor: null });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Chess")).toBeTruthy();
    expect(screen.getAllByText("Book Club")).toHaveLength(1);
    expect(api.listDirectoryCommunities).toHaveBeenLastCalledWith({ domain: null, q: "", cursor: "C1" });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("Browse: when it cannot be shown", () => {
  it.each([
    [new ApiError(404, { error: "directory_disabled" }), "This server doesn't publish a directory."],
    [new ApiError(500, { error: "internal_error" }), "Couldn't load the directory. Try again."],
  ])("says so for this server (%#)", async (error, message) => {
    api.listDirectoryCommunities.mockRejectedValue(error);
    renderPage();

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  it.each([
    [new ApiError(404, { error: "directory_disabled" }), "far.example doesn't publish a directory."],
    [new ApiError(502, { error: "federation_unreachable" }), "Couldn't reach far.example. Try again later."],
    [new ApiError(403, { error: "federation_domain_blocked" }), "This server doesn't connect to that server, so this can't be done."],
    [new ApiError(403, { error: "federation_disabled" }), "This server doesn't connect to other servers, so this can only be done with people on it."],
    [new ApiError(400, { error: "invalid_request" }), "That isn't a server name or a search the directory understands."],
  ])("says so for another server (%#)", async (error, message) => {
    renderPage();
    await screen.findByText("Book Club");
    api.listDirectoryCommunities.mockRejectedValue(error);

    fireEvent.change(serverBox(), { target: { value: "far.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });
});

describe("Browse: another server", () => {
  it("asks for that server, tidying what was typed, and says whose it is, with a way back", async () => {
    renderPage();
    await screen.findByText("Book Club");
    api.listDirectoryCommunities.mockResolvedValue({ items: [club({ domain: "far.example", name: "Far Club" })], nextCursor: null });

    fireEvent.change(serverBox(), { target: { value: "  https://Far.Example/ " } });
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    expect(await screen.findByText("Far Club")).toBeTruthy();
    expect(api.listDirectoryCommunities).toHaveBeenLastCalledWith({ domain: "far.example", q: "", cursor: null });
    expect(screen.getByText("far.example", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText(/1 member|12 members/).textContent).toContain("far.example");

    api.listDirectoryCommunities.mockResolvedValue({ items: [club()], nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Back to this server" }));
    await waitFor(() => expect(api.listDirectoryCommunities).toHaveBeenLastCalledWith({ domain: null, q: "", cursor: null }));
  });

  it("joins by the id and the server it was listed on", async () => {
    renderPage();
    await screen.findByText("Book Club");
    api.listDirectoryCommunities.mockResolvedValue({ items: [club({ id: "FC1", domain: "far.example", name: "Far Club" })], nextCursor: null });
    fireEvent.change(serverBox(), { target: { value: "far.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    fireEvent.click(await screen.findByRole("button", { name: "Join Far Club" }));

    await waitFor(() => expect(api.joinCommunity).toHaveBeenCalledWith("FC1:far.example"));
  });

  it("is not offered on a private server, which does not connect to others", async () => {
    setFederationEnabled(false);
    renderPage();
    await screen.findByText("Book Club");

    expect(screen.queryByLabelText("Server to browse")).toBeNull();
  });

  it("drops the answer to an older question when a newer one has been asked", async () => {
    let answerSlow!: (page: unknown) => void;
    api.listDirectoryCommunities.mockReturnValueOnce(new Promise((resolve) => (answerSlow = resolve)));
    renderPage();
    api.listDirectoryCommunities.mockResolvedValueOnce({ items: [club({ name: "Fast one" })], nextCursor: null });

    fireEvent.change(serverBox(), { target: { value: "far.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    expect(await screen.findByText("Fast one")).toBeTruthy();
    answerSlow({ items: [club({ name: "Slow one" })], nextCursor: null });

    await waitFor(() => expect(screen.queryByText("Slow one")).toBeNull());
    expect(screen.getByText("Fast one")).toBeTruthy();
  });
});

describe("Browse: a slow failure", () => {
  it("does not replace what a newer question found with an error from an older one", async () => {
    let failSlow!: (error: unknown) => void;
    api.listDirectoryCommunities.mockReturnValueOnce(new Promise((_resolve, reject) => (failSlow = reject)));
    renderPage();
    api.listDirectoryCommunities.mockResolvedValueOnce({ items: [club({ name: "Fast one" })], nextCursor: null });

    fireEvent.change(serverBox(), { target: { value: "far.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    expect(await screen.findByText("Fast one")).toBeTruthy();
    failSlow(new ApiError(502, { error: "federation_unreachable" }));

    await waitFor(() => expect(screen.getByText("Fast one")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Browse: people", () => {
  async function openPeople() {
    renderPage();
    await screen.findByText("Book Club");
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
  }

  it("lists who chose to be listed, with their handle and bio as text", async () => {
    api.listDirectoryPeople.mockResolvedValue({ items: [person({ displayName: "<i>Rex</i>", bio: "<script>x</script>" })], nextCursor: null });
    await openPeople();

    expect(await screen.findByText("<i>Rex</i>")).toBeTruthy();
    expect(screen.getByText("@rex:chat.example")).toBeTruthy();
    expect(screen.getByText("<script>x</script>")).toBeTruthy();
    expect(api.listDirectoryPeople).toHaveBeenCalledWith({ domain: null, q: "", cursor: null });
  });

  it("sends a friend request to the person, by handle, and says so", async () => {
    await openPeople();

    fireEvent.click(await screen.findByRole("button", { name: "Add Rex as a friend" }));

    await waitFor(() => expect(api.sendFriendRequest).toHaveBeenCalledWith("rex:chat.example"));
    expect(await screen.findByText("Friend request sent.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add Rex as a friend" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says plainly when it did not go through", async () => {
    api.sendFriendRequest.mockRejectedValue({ body: { error: "contact_not_allowed" } });
    await openPeople();

    fireEvent.click(await screen.findByRole("button", { name: "Add Rex as a friend" }));

    expect(await screen.findByText("This person isn't accepting friend requests from you.")).toBeTruthy();
  });

  it("shows someone who is already a friend as one, with nothing to press", async () => {
    appData.value.friends = [{ identity: "@Rex:chat.example" }];
    await openPeople();

    await screen.findByText("Rex");
    expect(screen.queryByRole("button", { name: "Add Rex as a friend" })).toBeNull();
    expect(within(document.body).getByText("Friends")).toBeTruthy();
  });

  it("says when no one is listed, and searches people by name", async () => {
    api.listDirectoryPeople.mockResolvedValue({ items: [], nextCursor: null });
    await openPeople();
    expect(await screen.findByText("No one on this server has chosen to be listed yet.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search people"), { target: { value: "rex" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(api.listDirectoryPeople).toHaveBeenLastCalledWith({ domain: null, q: "rex", cursor: null }));
  });
});
