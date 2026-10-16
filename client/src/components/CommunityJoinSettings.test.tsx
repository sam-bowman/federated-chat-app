import { ApiError } from "../api/client";
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

const community = (over: { visibility?: Community["visibility"]; openJoin?: boolean; visibilityLimit?: Community["visibilityLimit"] }) => ({ id: "C1", name: "Club", ...over }) as unknown as Community;
const choice = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;
const selected = () => screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked).map((r) => (r as HTMLInputElement).value);

describe("Settings -> General -> Who can join", () => {
  it("offers the four choices as one group, with the community's own selected", () => {
    render(<CommunityJoinSettings community={community({ visibility: "LOCAL_ONLY" })} />);

    expect(screen.getByRole("group", { name: "Who can join" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(selected()).toEqual(["LOCAL_ONLY"]);
  });

  it.each([
    [{ visibility: "UNLISTED" as const }, "UNLISTED"],
    [{ visibility: "INVITE_ONLY" as const }, "INVITE_ONLY"],
    // A server from before the setting sends only the old yes/no, and one from before that sent nothing, which meant open.
    [{ openJoin: false }, "INVITE_ONLY"],
    [{ openJoin: true }, "UNLISTED"],
    [{}, "UNLISTED"],
  ])("reads %j as %s", (over, expected) => {
    render(<CommunityJoinSettings community={community(over)} />);

    expect(selected()).toEqual([expected]);
  });

  it("says what each choice means", () => {
    render(<CommunityJoinSettings community={community({})} />);

    expect(screen.getByText(/Anyone who has the code can join, on this server or another/)).toBeTruthy();
    expect(screen.getByText(/the community code no longer lets anyone in/)).toBeTruthy();
    expect(screen.getByText(/People on other servers can't, and are told there is no such community/)).toBeTruthy();
    expect(screen.getByText(/Anyone from another server who is already in stays/)).toBeTruthy();
  });

  it.each([
    [/^Only people with an invite/, "INVITE_ONLY"],
    [/^Only people on this server/, "LOCAL_ONLY"],
  ])("saves %s at once, then reloads the communities", async (name, value) => {
    render(<CommunityJoinSettings community={community({ visibility: "UNLISTED" })} />);

    fireEvent.click(choice(name));

    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { visibility: value }));
    await waitFor(() => expect(refreshCommunities).toHaveBeenCalled());
  });

  it("can make a community public, to be listed in the directory", async () => {
    render(<CommunityJoinSettings community={community({ visibility: "UNLISTED" })} />);

    fireEvent.click(choice(/^Public: listed in the directory/));

    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { visibility: "PUBLIC" }));
  });

  it("says a public community is not listed yet when the server publishes no directory, and says nothing when it does", () => {
    const { unmount } = render(<CommunityJoinSettings community={community({ visibility: "PUBLIC" })} directoryPublished={false} />);
    expect(screen.getByText(/doesn't publish a directory, so for now this works like/)).toBeTruthy();
    unmount();

    render(<CommunityJoinSettings community={community({ visibility: "PUBLIC" })} directoryPublished />);
    expect(screen.queryByText(/doesn't publish a directory/)).toBeNull();
  });

  it("opens an invite-only community again", async () => {
    render(<CommunityJoinSettings community={community({ visibility: "INVITE_ONLY" })} />);

    fireEvent.click(choice(/^Anyone with the community code/));

    await waitFor(() => expect(updateCommunity).toHaveBeenCalledWith("C1", { visibility: "UNLISTED" }));
  });

  it("shows the choice at once, while it saves, and cannot be changed again until it has", async () => {
    let finish!: () => void;
    updateCommunity.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    render(<CommunityJoinSettings community={community({ visibility: "UNLISTED" })} />);

    fireEvent.click(choice(/^Only people on this server/));

    expect(selected()).toEqual(["LOCAL_ONLY"]); // before the server has answered
    // (inputs inside a disabled fieldset are disabled without the property saying so)
    await waitFor(() => expect(choice(/^Anyone with the community code/).matches(":disabled")).toBe(true));
    finish();
    await waitFor(() => expect(choice(/^Anyone with the community code/).matches(":disabled")).toBe(false));
  });

  it("says when it could not change it, and goes back to what is saved", async () => {
    updateCommunity.mockRejectedValue(new Error("403"));
    render(<CommunityJoinSettings community={community({ visibility: "UNLISTED" })} />);

    fireEvent.click(choice(/^Only people on this server/));

    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't change that");
    expect(refreshCommunities).not.toHaveBeenCalled();
    expect(selected()).toEqual(["UNLISTED"]);
  });

  it("clears an earlier failure on the next attempt", async () => {
    updateCommunity.mockRejectedValueOnce(new Error("403"));
    render(<CommunityJoinSettings community={community({ visibility: "UNLISTED" })} />);
    fireEvent.click(choice(/^Only people with an invite/));
    await screen.findByRole("alert");

    fireEvent.click(choice(/^Only people with an invite/));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("Settings -> General -> Who can join, under a server's limit", () => {
  const disabled = () => screen.getAllByRole("radio").filter((r) => r.matches(":disabled")).map((r) => (r as HTMLInputElement).value);

  it("disables the choices that are more open than the server lets a community be, and says why", () => {
    render(<CommunityJoinSettings community={community({ visibility: "UNLISTED", visibilityLimit: "UNLISTED" })} />);

    expect(disabled()).toEqual(["PUBLIC"]);
    expect(screen.getByText("This server doesn't let a community be this open.")).toBeTruthy();
  });

  it.each([
    ["PUBLIC", []],
    ["UNLISTED", ["PUBLIC"]],
    ["INVITE_ONLY", ["UNLISTED", "PUBLIC"]],
    ["LOCAL_ONLY", ["UNLISTED", "PUBLIC", "INVITE_ONLY"]],
  ] as const)("with a limit of %s disables %j", (limit, expected) => {
    render(<CommunityJoinSettings community={community({ visibility: "LOCAL_ONLY", visibilityLimit: limit })} />);

    expect(disabled().sort()).toEqual([...expected].sort());
  });

  it("disables nothing when the server sends no limit, as an older one does", () => {
    render(<CommunityJoinSettings community={community({ visibility: "UNLISTED" })} />);

    expect(disabled()).toEqual([]);
  });

  it("shows what is in force, which is the limit when the community was set wider", () => {
    render(<CommunityJoinSettings community={community({ visibility: "UNLISTED", visibilityLimit: "UNLISTED" })} />);

    expect(screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked).map((r) => (r as HTMLInputElement).value)).toEqual(["UNLISTED"]);
  });

  it("says so if the server refuses a choice because of its limit", async () => {
    updateCommunity.mockRejectedValue(new ApiError(409, { error: "visibility_limited", limit: "UNLISTED" }));
    render(<CommunityJoinSettings community={community({ visibility: "INVITE_ONLY" })} />);

    fireEvent.click(screen.getByRole("radio", { name: /^Public: listed in the directory/ }));

    expect((await screen.findByRole("alert")).textContent).toBe("This server doesn't let a community be that open.");
  });
});
