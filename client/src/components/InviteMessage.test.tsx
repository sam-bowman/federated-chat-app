import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community, InviteCard } from "../api";
import { ApiError } from "../api/client";
import InviteMessage from "./InviteMessage";

const joinCommunity = vi.fn();
vi.mock("../api", () => ({ joinCommunity: (...args: unknown[]) => joinCommunity(...args) }));

const appData = vi.hoisted(() => ({
  value: { communities: [] as { id: string }[], refreshCommunities: vi.fn() },
}));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => appData.value }));

beforeEach(() => {
  appData.value = { communities: [], refreshCommunities: vi.fn().mockResolvedValue(undefined) };
  joinCommunity.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const card: InviteCard = { communityId: "01JCOMMUNITY", domain: "far.example", name: "Book Club" };

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderCard(props: { invite?: InviteCard; isOwn?: boolean } = {}) {
  render(
    <MemoryRouter initialEntries={["/dm/1"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <InviteMessage invite={props.invite ?? card} senderName="Alice" isOwn={props.isOwn ?? false} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe("InviteMessage: what it shows", () => {
  it("shows who invited you, the community and its server, and a Join button", () => {
    renderCard();

    expect(screen.getByText("Alice invited you to join")).toBeTruthy();
    expect(screen.getByText("Book Club")).toBeTruthy();
    expect(screen.getByText("far.example")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
  });

  it("shows what you sent, with nothing to press, to the person who sent it", () => {
    renderCard({ isOwn: true });

    expect(screen.getByText("You invited them to join")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  // The name was typed by whoever made the community.
  it("shows a name containing markup as text", () => {
    const hostile = '<img src=x onerror="alert(1)"><b>Free</b>';
    renderCard({ invite: { ...card, name: hostile } });

    expect(screen.getByText(hostile)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });

  it("uses the community's first letter as its icon, whatever the case", () => {
    renderCard({ invite: { ...card, name: "  book club" } });

    expect(document.querySelector(".invite-card-icon")!.textContent).toBe("B");
  });
});

describe("InviteMessage: joining", () => {
  it("joins with the code on the card, refreshes the list, and opens the community", async () => {
    const { refreshCommunities } = appData.value;
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/communities/01JCOMMUNITY"));
    expect(joinCommunity).toHaveBeenCalledWith("01JCOMMUNITY:far.example");
    expect(refreshCommunities).toHaveBeenCalledOnce();
  });

  it("is busy while joining, so it cannot be pressed twice", async () => {
    let finish: (value: unknown) => void = () => {};
    joinCommunity.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    const button = await screen.findByRole("button", { name: "Join" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(joinCommunity).toHaveBeenCalledOnce();
    finish({});
  });

  it("says you are in once you are, and offers to open the community instead of joining again", () => {
    appData.value = { communities: [{ id: "01JCOMMUNITY" }] as Community[], refreshCommunities: vi.fn() };
    renderCard();

    expect(screen.getByText("Joined")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByTestId("where").textContent).toBe("/communities/01JCOMMUNITY");
    expect(joinCommunity).not.toHaveBeenCalled();
  });
});

// A card can be old: the person was banned since, the community was deleted, its server is down.
describe("InviteMessage: when joining fails", () => {
  it.each([
    ["banned", new ApiError(403, { error: "banned" }), "You can't join this community."],
    ["gone", new ApiError(404, { error: "not_found" }), "This community doesn't exist any more."],
    ["unreachable", new ApiError(502, { error: "federation_unreachable" }), "Couldn't reach far.example. Try again later."],
    ["something else", new ApiError(500, { error: "internal_error" }), "Couldn't join. Try again."],
    ["a network failure", new TypeError("Failed to fetch"), "Couldn't join. Try again."],
  ])("says why when %s, stays on the card, and can be tried again", async (_name, failure, message) => {
    joinCommunity.mockRejectedValue(failure);
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(screen.getByTestId("where").textContent).toBe("/dm/1");
    expect((screen.getByRole("button", { name: "Join" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the message on the next attempt", async () => {
    joinCommunity.mockRejectedValueOnce(new ApiError(500, {})).mockResolvedValueOnce({});
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/communities/01JCOMMUNITY"));
  });
});
