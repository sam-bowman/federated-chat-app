import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { resetFederationState, setFederationEnabled } from "../lib/federation";
import NewCommunityModal from "./NewCommunityModal";

const joinCommunity = vi.fn();
const createCommunity = vi.fn();
vi.mock("../api", () => ({
  joinCommunity: (...args: unknown[]) => joinCommunity(...args),
  createCommunity: (...args: unknown[]) => createCommunity(...args),
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", identity: "@me:chat.example", username: "me", displayName: "Me", avatarUrl: null } }),
}));
const refreshCommunities = vi.fn();
vi.mock("../context/AppDataContext", () => ({ useAppData: () => ({ refreshCommunities }) }));

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderModal() {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={["/friends"]}>
      <NewCommunityModal onClose={onClose} />
      <Where />
    </MemoryRouter>
  );
  return { onClose };
}

beforeEach(() => {
  refreshCommunities.mockResolvedValue(undefined);
  joinCommunity.mockResolvedValue({ id: "C1" });
  createCommunity.mockResolvedValue({ id: "C9" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function joinTab() {
  fireEvent.click(screen.getByRole("tab", { name: "Join by ID" }));
}
const box = () => screen.getByPlaceholderText(/Invite code/) as HTMLInputElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Join" }));

describe("NewCommunityModal: joining by an invite code", () => {
  it("joins with exactly what was pasted, an id, an id and server, or either with an invite after a #", async () => {
    for (const pasted of ["01JABC", "01JABC:far.example", "01JABC:far.example#K7M2QXR9TB"]) {
      joinCommunity.mockClear();
      cleanup();
      renderModal();
      joinTab();
      type(`  ${pasted}  `);

      submit();

      await waitFor(() => expect(joinCommunity).toHaveBeenCalledWith(pasted));
    }
  });

  it("closes and opens the community it joined", async () => {
    const { onClose } = renderModal();
    joinTab();
    type("01JABC:far.example#K7M2QXR9TB");

    submit();

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/communities/C1"));
    expect(onClose).toHaveBeenCalled();
    expect(refreshCommunities).toHaveBeenCalled();
  });

  it("has nothing to submit until something is typed", () => {
    renderModal();
    joinTab();

    expect((screen.getByRole("button", { name: "Join" }) as HTMLButtonElement).disabled).toBe(true);
    type("   ");
    expect((screen.getByRole("button", { name: "Join" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["an expired invite", new ApiError(403, { error: "invite_expired" }), "This invitation has expired. Ask for a new one."],
    ["a used up invite", new ApiError(403, { error: "invite_used_up" }), "This invitation has already been used. Ask for a new one."],
    ["a cancelled invite", new ApiError(403, { error: "invite_revoked" }), "This invitation was cancelled. Ask for a new one."],
    ["an invite that is not one", new ApiError(403, { error: "invite_invalid" }), "This invitation isn't valid."],
    ["an invite-only community with no invite", new ApiError(403, { error: "invite_required" }), "This community is invite-only. Ask a member to invite you."],
    ["a ban", new ApiError(403, { error: "banned" }), "You can't join this community."],
    ["a server that cannot be reached", new ApiError(502, { error: "federation_unreachable" }), "Couldn't reach far.example. Try again later."],
  ])("explains %s", async (_name, failure, message) => {
    joinCommunity.mockRejectedValue(failure);
    renderModal();
    joinTab();
    type("01JABC:far.example#K7M2QXR9TB");

    submit();

    expect((await screen.findByText(message)).className).toContain("error-text");
  });

  it("keeps the box's own message for a community that is not there, or a network failure", async () => {
    joinCommunity.mockRejectedValue(new ApiError(404, { error: "not_found" }));
    renderModal();
    joinTab();
    type("01JNOPE");

    submit();
    expect(await screen.findByText("Couldn't find or join that community.")).toBeTruthy();

    joinCommunity.mockRejectedValue(new TypeError("Failed to fetch"));
    submit();
    await waitFor(() => expect(joinCommunity).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Couldn't find or join that community.")).toBeTruthy();
  });

  it("can be tried again after a failure, with the error cleared", async () => {
    joinCommunity.mockRejectedValueOnce(new ApiError(403, { error: "invite_expired" }));
    renderModal();
    joinTab();
    type("01JABC:far.example#K7M2QXR9TB");
    submit();
    await screen.findByText(/has expired/);

    type("01JABC:far.example#NEWINVITE9");
    submit();

    await waitFor(() => expect(joinCommunity).toHaveBeenLastCalledWith("01JABC:far.example#NEWINVITE9"));
    await waitFor(() => expect(screen.queryByText(/has expired/)).toBeNull());
  });
});

describe("NewCommunityModal: creating", () => {
  it("still creates a community, and a failure there is the create message, not a join one", async () => {
    createCommunity.mockRejectedValueOnce(new ApiError(403, { error: "invite_expired" }));
    renderModal();
    fireEvent.change(screen.getByPlaceholderText("Community name"), { target: { value: "Club" } });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Couldn't create community.")).toBeTruthy();
    expect(joinCommunity).not.toHaveBeenCalled();
  });
});

describe("NewCommunityModal: joining on a private server", () => {
  afterEach(() => resetFederationState());

  it.each(["01JABC:far.example", "01JABC:far.example#K7M2QXR9TB", "@01JABC:far.example:8443#K7M2QXR9TB"])(
    "says why, without asking the server, for %s on another server",
    async (pasted) => {
      setFederationEnabled(false);
      renderModal();
      joinTab();
      type(pasted);

      submit();

      expect(await screen.findByText("This server doesn't connect to other servers, so you can't join a community on one.")).toBeTruthy();
      expect(joinCommunity).not.toHaveBeenCalled();
    }
  );

  it.each(["01JABC", "01JABC:chat.example", "01JABC:CHAT.example#K7M2QXR9TB"])("still joins %s, which is on this server", async (pasted) => {
    setFederationEnabled(false);
    renderModal();
    joinTab();
    type(pasted);

    submit();

    await waitFor(() => expect(joinCommunity).toHaveBeenCalledWith(pasted));
  });

  it("joins a community on another server when federation is on", async () => {
    renderModal();
    joinTab();
    type("01JABC:far.example#K7M2QXR9TB");

    submit();

    await waitFor(() => expect(joinCommunity).toHaveBeenCalledWith("01JABC:far.example#K7M2QXR9TB"));
  });

  it("says the same if the server refuses (it was turned private since the page loaded)", async () => {
    joinCommunity.mockRejectedValue(new ApiError(403, { error: "federation_disabled" }));
    renderModal();
    joinTab();
    type("01JABC:far.example");

    submit();

    expect(await screen.findByText(/doesn't connect to other servers, so you can't join a community on one/)).toBeTruthy();
  });

  // The operator may limit which servers this one talks to; that server alone is off limits, so it is named.
  it("names the server when only that one is off limits", async () => {
    joinCommunity.mockRejectedValue(new ApiError(403, { error: "federation_domain_blocked" }));
    renderModal();
    joinTab();
    type("01JABC:far.example");

    submit();

    expect(await screen.findByText("This server doesn't connect to far.example, so you can't join a community there.")).toBeTruthy();
  });

  it("clears the message when the next attempt is allowed", async () => {
    setFederationEnabled(false);
    renderModal();
    joinTab();
    type("01JABC:far.example");
    submit();
    await screen.findByText(/doesn't connect/);

    type("01JABC");
    submit();

    await waitFor(() => expect(screen.queryByText(/doesn't connect/)).toBeNull());
  });
});
