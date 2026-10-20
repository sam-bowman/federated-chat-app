import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Community } from "../api";
import { ApiError } from "../api/client";
import ChannelsPanel from "./ChannelsPanel";

const updateChannel = vi.fn();
const deleteChannel = vi.fn();
const reorderChannels = vi.fn();
vi.mock("../api", () => ({
  updateChannel: (...args: unknown[]) => updateChannel(...args),
  deleteChannel: (...args: unknown[]) => deleteChannel(...args),
  reorderChannels: (...args: unknown[]) => reorderChannels(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeCommunity(channels: { id: string; name: string; topic: string | null; position: number; type?: "TEXT" | "VOICE" }[]) {
  return { id: "C1", channels } as unknown as Community;
}

// Deliberately out of position order, to prove the panel sorts them.
const three = makeCommunity([
  { id: "ch-b", name: "beta", topic: "second one", position: 1 },
  { id: "ch-a", name: "alpha", topic: null, position: 0 },
  { id: "ch-c", name: "gamma", topic: null, position: 2 },
]);

function renderPanel(community: Community = three) {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const utils = render(<ChannelsPanel community={community} onChanged={onChanged} />);
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".friend-request-row"));
  return { ...utils, onChanged, rows };
}

describe("ChannelsPanel - list and reorder", () => {
  it("lists channels in position order with their topics", () => {
    const { rows } = renderPanel();

    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining("# alpha"),
      expect.stringContaining("# beta"),
      expect.stringContaining("# gamma"),
    ]);
    expect(rows()[1].textContent).toContain("second one");
  });

  it("can't move the first channel up or the last one down", () => {
    renderPanel();

    expect((screen.getByLabelText("Move alpha up") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Move gamma down") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Move beta up") as HTMLButtonElement).disabled).toBe(false);
  });

  it("moving a channel up sends the whole new order", async () => {
    reorderChannels.mockResolvedValue([]);
    const { onChanged } = renderPanel();

    fireEvent.click(screen.getByLabelText("Move beta up"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(reorderChannels).toHaveBeenCalledWith("C1", ["ch-b", "ch-a", "ch-c"]);
  });

  it("moving a channel down swaps it with the one below", async () => {
    reorderChannels.mockResolvedValue([]);
    const { onChanged } = renderPanel();

    fireEvent.click(screen.getByLabelText("Move alpha down"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(reorderChannels).toHaveBeenCalledWith("C1", ["ch-b", "ch-a", "ch-c"]);
  });
});

describe("ChannelsPanel - editing", () => {
  it("opens a channel's current name and topic, and saves changes (a blank topic is sent as null)", async () => {
    updateChannel.mockResolvedValue({});
    const { onChanged, rows } = renderPanel();

    fireEvent.click(within(rows()[1]).getByText("Edit"));
    expect(screen.getByDisplayValue("beta")).toBeTruthy();
    expect(screen.getByDisplayValue("second one")).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue("beta"), { target: { value: "  delta  " } });
    fireEvent.change(screen.getByDisplayValue("second one"), { target: { value: "   " } });
    fireEvent.click(screen.getByText("Save channel"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(updateChannel).toHaveBeenCalledWith("C1", "ch-b", { name: "delta", topic: null });
  });

  it("won't save without a name, and Cancel discards the edit", () => {
    const { rows } = renderPanel();

    fireEvent.click(within(rows()[0]).getByText("Edit"));
    fireEvent.change(screen.getByDisplayValue("alpha"), { target: { value: "" } });
    expect((screen.getByText("Save channel") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText("Cancel"));
    expect(updateChannel).not.toHaveBeenCalled();
    expect(rows()[0].textContent).toContain("# alpha");
  });
});

describe("ChannelsPanel - deleting", () => {
  it("asks first, warning that every message goes with the channel, and only deletes on confirm", async () => {
    deleteChannel.mockResolvedValue(undefined);
    const { onChanged, rows } = renderPanel();

    fireEvent.click(within(rows()[2]).getByText("Delete"));
    expect(deleteChannel).not.toHaveBeenCalled();
    await screen.findByText(/Permanently delete #gamma\? Every message in it is deleted with it/);

    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));

    await waitFor(() => expect(deleteChannel).toHaveBeenCalledWith("C1", "ch-c"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("cancelling the confirmation deletes nothing", async () => {
    const { rows } = renderPanel();

    fireEvent.click(within(rows()[2]).getByText("Delete"));
    await screen.findByText(/Permanently delete #gamma/);
    fireEvent.click(screen.getByText("Cancel"));

    expect(deleteChannel).not.toHaveBeenCalled();
  });

  it("offers no Delete when there's only one channel, and says why", () => {
    const { rows } = renderPanel(makeCommunity([{ id: "ch-a", name: "general", topic: null, position: 0 }]));

    expect(within(rows()[0]).queryByText("Delete")).toBeNull();
    expect(screen.getByText(/always keeps at least one channel/)).toBeTruthy();
  });

  it("shows a server refusal and leaves the list as it was", async () => {
    deleteChannel.mockRejectedValue(new ApiError(409, { error: "last_channel" }));
    const { onChanged, rows } = renderPanel();

    fireEvent.click(within(rows()[0]).getByText("Delete"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete channel" }));

    await screen.findByText(/has to keep at least one channel/);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("ChannelsPanel - voice channels", () => {
  it("marks a voice channel with a speaker rather than a hash, and a text one with a hash", () => {
    const { rows } = renderPanel(
      makeCommunity([
        { id: "t", name: "general", topic: null, position: 0, type: "TEXT" },
        { id: "v", name: "Lounge", topic: null, position: 1, type: "VOICE" },
      ])
    );
    expect(rows().map((row) => row.querySelector(".grow > div")?.textContent)).toEqual(["# general", "🔊 Lounge"]);
  });
});
