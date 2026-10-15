import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community } from "../api";
import { ApiError } from "../api/client";
import CommunityDangerZone from "./CommunityDangerZone";

const transferCommunityOwner = vi.fn();
const deleteCommunity = vi.fn();
vi.mock("../api", () => ({
  transferCommunityOwner: (...args: unknown[]) => transferCommunityOwner(...args),
  deleteCommunity: (...args: unknown[]) => deleteCommunity(...args),
}));

const refreshCommunities = vi.fn();
vi.mock("../context/AppDataContext", () => ({ useAppData: () => ({ refreshCommunities }) }));

beforeEach(() => {
  refreshCommunities.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const person = (id: string, name: string, domain = "chat.example") => ({
  id,
  identity: `@${name}:${domain}`,
  username: name,
  displayName: name[0].toUpperCase() + name.slice(1),
  avatarUrl: null,
});

const community = {
  id: "C1",
  name: "Book Club",
  owner: person("owner", "olive"),
  channels: [{ id: "ch1" }, { id: "ch2" }],
  members: [
    person("owner", "olive"),
    person("ben", "ben"),
    person("cara", "cara"),
    person("remy", "remy", "far.example"),
  ],
} as unknown as Community;

const owner = { id: "owner", identity: "@olive:chat.example" };

function setup(viewer = owner, onFinished = vi.fn()) {
  render(<CommunityDangerZone community={community} viewer={viewer} onFinished={onFinished} />);
  return { onFinished };
}

describe("CommunityDangerZone", () => {
  it("is for the owner only: a member, even one who can manage the community, sees nothing", () => {
    setup({ id: "ben", identity: "@ben:chat.example" });
    expect(screen.queryByText("Danger zone")).toBeNull();
    expect(screen.queryByText(/Delete community/)).toBeNull();
  });

  it("offers the owner both ways out", () => {
    setup();
    expect(screen.getByRole("region", { name: "Danger zone" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Transfer ownership…" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Delete community…" })).not.toBeNull();
  });
});

describe("transferring ownership", () => {
  function open() {
    const { onFinished } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Transfer ownership…" }));
    return { onFinished };
  }
  const submit = () => screen.getByRole("button", { name: "Transfer ownership" }) as HTMLButtonElement;

  it("offers only other members who are on this server", () => {
    open();
    const options = screen.getAllByRole("radio").map((r) => r.closest("label")!.textContent);
    expect(options.some((t) => t!.includes("@ben:chat.example"))).toBe(true);
    expect(options.some((t) => t!.includes("@cara:chat.example"))).toBe(true);
    expect(options.some((t) => t!.includes("@olive"))).toBe(false); // already the owner
    expect(options.some((t) => t!.includes("far.example"))).toBe(false); // a remote member could not manage it
  });

  it("filters the member list as you type", () => {
    open();
    fireEvent.change(screen.getByPlaceholderText("Search members"), { target: { value: "car" } });
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText("Search members"), { target: { value: "zzz" } });
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText("No member matches.")).not.toBeNull();
  });

  it("needs a chosen member and a password before it can be confirmed, and says what is given up", () => {
    open();
    expect(submit().disabled).toBe(true);

    fireEvent.click(screen.getAllByRole("radio")[0]);
    expect(submit().disabled).toBe(true);
    expect(screen.getByText(/lose the ability to manage it/)).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Confirm with your password"), { target: { value: "hunter2" } });
    expect(submit().disabled).toBe(false);
  });

  it("transfers with the chosen member and the password, refreshes, and finishes", async () => {
    transferCommunityOwner.mockResolvedValue({});
    const { onFinished } = open();

    fireEvent.click(screen.getAllByRole("radio")[1]); // cara
    fireEvent.change(screen.getByLabelText("Confirm with your password"), { target: { value: "hunter2" } });
    fireEvent.click(submit());

    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(transferCommunityOwner).toHaveBeenCalledWith("C1", "cara", "hunter2");
    expect(refreshCommunities).toHaveBeenCalled();
  });

  it.each([
    ["a wrong password", new ApiError(401, { error: "invalid_credentials" }), "That password isn't right."],
    ["too many attempts", new ApiError(429, "Too many requests"), "Too many attempts."],
    ["a member who has since left", new ApiError(404, { error: "not_a_member" }), "no longer a member"],
    ["anything else", new Error("offline"), "Couldn't transfer ownership."],
  ])("explains %s and stays open", async (_name, failure, text) => {
    transferCommunityOwner.mockRejectedValue(failure);
    const { onFinished } = open();
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.change(screen.getByLabelText("Confirm with your password"), { target: { value: "x" } });
    fireEvent.click(submit());

    expect((await screen.findByRole("alert")).textContent).toContain(text);
    expect(onFinished).not.toHaveBeenCalled();
    expect(submit().disabled).toBe(false); // can try again
  });

  // With nobody to choose, the dialog is only an explanation and a Close button: a disabled "Transfer
  // ownership" button and a password box looked like an action that might still work.
  describe("when there is nobody to hand it to", () => {
    function openFor(members: unknown[]) {
      const alone = { ...community, members } as unknown as Community;
      render(<CommunityDangerZone community={alone} viewer={owner} onFinished={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Transfer ownership…" }));
    }

    function expectOnlyAnExplanation() {
      expect(screen.queryAllByRole("radio")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Transfer ownership" })).toBeNull();
      expect(screen.queryByLabelText("Confirm with your password")).toBeNull();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(screen.getByRole("button", { name: "Close" })).not.toBeNull();
    }

    it("says nobody else is in the community when it has no other members", () => {
      openFor([person("owner", "olive")]);

      expect(screen.getByText(/Nobody else is in Book Club yet/)).not.toBeNull();
      expect(screen.queryByText(/another server/)).toBeNull();
      expectOnlyAnExplanation();
    });

    it("says the others are on another server when that is the reason", () => {
      openFor([person("owner", "olive"), person("remy", "remy", "far.example")]);

      expect(screen.getByText(/Everyone else in Book Club is on another server/)).not.toBeNull();
      expect(screen.queryByText(/Nobody else is in/)).toBeNull();
      expectOnlyAnExplanation();
    });

    it("closes the dialog with Close", () => {
      openFor([person("owner", "olive")]);

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(screen.queryByText(/Nobody else is in/)).toBeNull();
    });
  });
});

describe("deleting the community", () => {
  function open() {
    const { onFinished } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete community…" }));
    return { onFinished };
  }
  const confirm = () => screen.getByRole("button", { name: "Delete community" }) as HTMLButtonElement;
  const type = (value: string) =>
    fireEvent.change(screen.getByLabelText("Type the community's name to confirm"), { target: { value } });

  it("spells out what is lost", () => {
    open();
    const text = document.body.textContent!;
    expect(text).toContain("Book Club");
    expect(text).toContain("all 2 channels");
    expect(text).toContain("all 4 members");
    expect(text).toContain("cannot be undone");
  });

  it("stays disabled until the exact name is typed", () => {
    open();
    expect(confirm().disabled).toBe(true);
    type("book club");
    expect(confirm().disabled).toBe(true);
    type("Book Club ");
    expect(confirm().disabled).toBe(true);
    type("Book Club");
    expect(confirm().disabled).toBe(false);
  });

  it("deletes, refreshes and finishes", async () => {
    deleteCommunity.mockResolvedValue(undefined);
    const { onFinished } = open();
    type("Book Club");
    fireEvent.click(confirm());

    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(deleteCommunity).toHaveBeenCalledWith("C1");
    expect(refreshCommunities).toHaveBeenCalled();
  });

  it("reports a failure and stays open", async () => {
    deleteCommunity.mockRejectedValue(new ApiError(403, { error: "forbidden" }));
    const { onFinished } = open();
    type("Book Club");
    fireEvent.click(confirm());

    expect((await screen.findByRole("alert")).textContent).toContain("Only the owner");
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("does nothing when cancelled", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Type the community's name to confirm")).toBeNull();
    expect(deleteCommunity).not.toHaveBeenCalled();
  });
});
