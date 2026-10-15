import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community } from "../api";
import CommunityJoinSettings from "./CommunityJoinSettings";

const updateCommunity = vi.fn();
vi.mock("../api", () => ({ updateCommunity: (...args: unknown[]) => updateCommunity(...args) }));

const refreshCommunities = vi.fn();
vi.mock("../context/AppDataContext", () => ({ useAppData: () => ({ refreshCommunities }) }));

beforeEach(() => {
  updateCommunity.mockResolvedValue({});
  refreshCommunities.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const community = (openJoin: boolean | undefined) => ({ id: "C1", name: "Club", openJoin }) as unknown as Community;
const checkbox = () => screen.getByRole("checkbox", { name: "Anyone with the community code can join" }) as HTMLInputElement;

describe("Settings -> General -> Joining", () => {
  it("is on for an open community, and says how to close it", () => {
    render(<CommunityJoinSettings community={community(true)} />);

    expect(checkbox().checked).toBe(true);
    expect(screen.getByText(/Turn this off to make the community invite-only/)).toBeTruthy();
  });

  it("is on for a server that does not say, which has always been open", () => {
    render(<CommunityJoinSettings community={community(undefined)} />);

    expect(checkbox().checked).toBe(true);
  });

  it("is off for an invite-only community, and says what that means", () => {
    render(<CommunityJoinSettings community={community(false)} />);

    expect(checkbox().checked).toBe(false);
    expect(screen.getByText(/invite-only/)).toBeTruthy();
    expect(screen.getByText(/no longer lets anyone in/)).toBeTruthy();
  });

  it("closes the community at once when turned off, then reloads the communities", async () => {
    render(<CommunityJoinSettings community={community(true)} />);

    fireEvent.click(checkbox());

    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { openJoin: false }));
    await waitFor(() => expect(refreshCommunities).toHaveBeenCalled());
  });

  it("opens it again when turned on", async () => {
    render(<CommunityJoinSettings community={community(false)} />);

    fireEvent.click(checkbox());

    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { openJoin: true }));
  });

  it("is disabled while it saves, so it cannot be flipped twice", async () => {
    let finish!: () => void;
    updateCommunity.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    render(<CommunityJoinSettings community={community(true)} />);

    fireEvent.click(checkbox());

    await waitFor(() => expect(checkbox().disabled).toBe(true));
    finish();
    await waitFor(() => expect(checkbox().disabled).toBe(false));
  });

  it("says when it could not change it, and the saved setting stays what the community says", async () => {
    updateCommunity.mockRejectedValue(new Error("403"));
    render(<CommunityJoinSettings community={community(true)} />);

    fireEvent.click(checkbox());

    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't change that");
    expect(refreshCommunities).not.toHaveBeenCalled();
    expect(checkbox().checked).toBe(true);
  });

  it("clears an earlier failure on the next attempt", async () => {
    updateCommunity.mockRejectedValueOnce(new Error("403"));
    render(<CommunityJoinSettings community={community(true)} />);
    fireEvent.click(checkbox());
    await screen.findByRole("alert");

    fireEvent.click(checkbox());

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
