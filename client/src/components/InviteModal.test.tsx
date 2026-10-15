import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community, PublicUser } from "../api";
import InviteModal from "./InviteModal";

const inviteToCommunity = vi.fn();
const listCommunityBans = vi.fn();
vi.mock("../api", () => ({
  inviteToCommunity: (...args: unknown[]) => inviteToCommunity(...args),
  listCommunityBans: (...args: unknown[]) => listCommunityBans(...args),
}));

const appData = vi.hoisted(() => ({ value: { friends: [] as unknown[] } }));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => appData.value }));

const person = (id: string, name: string, domain = "chat.example") =>
  ({ id, identity: `@${name}:${domain}`, username: name, displayName: name[0].toUpperCase() + name.slice(1), avatarUrl: null }) as PublicUser;

const owner = person("owner", "olive");
const bob = person("bob", "bob");
const cara = person("cara", "cara");
const remy = person("remy", "remy", "far.example"); // a friend on another server

function community(members: PublicUser[] = [owner]): Community {
  return {
    id: "01JCOMMUNITY",
    name: "Book Club",
    homeserverDomain: "chat.example",
    owner,
    roles: [],
    members: members.map((m) => ({ ...m, roleIds: [] })),
    channels: [],
  } as unknown as Community;
}

const viewerOwner = { id: owner.id, identity: owner.identity };
const viewerPlain = { id: "plain", identity: "@plain:chat.example" };

function open(options: { members?: PublicUser[]; friends?: PublicUser[]; viewer?: { id: string; identity: string } } = {}) {
  appData.value = { friends: options.friends ?? [bob, cara, remy] };
  const onClose = vi.fn();
  render(<InviteModal community={community(options.members)} viewer={options.viewer ?? viewerOwner} onClose={onClose} />);
  return { onClose };
}

const writeText = vi.fn();
beforeEach(() => {
  writeText.mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  inviteToCommunity.mockResolvedValue({});
  listCommunityBans.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("InviteModal: the invite code", () => {
  it("shows the code that joins from any server: the id and where it lives", () => {
    open();

    expect(screen.getByRole("dialog", { name: "Invite to Book Club" })).toBeTruthy();
    expect((screen.getByLabelText("Invite code") as HTMLInputElement).value).toBe("01JCOMMUNITY:chat.example");
    expect((screen.getByLabelText("Invite code") as HTMLInputElement).readOnly).toBe(true);
  });

  it("copies it, and says so", async () => {
    open();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await screen.findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith("01JCOMMUNITY:chat.example");
    expect(screen.getByRole("status").textContent).toContain("Copied");
  });

  it("does not claim it copied when the clipboard is not available", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    open();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});

describe("InviteModal: who can be invited", () => {
  it("lists friends who are not in the community, on this server or another", () => {
    open();

    expect(screen.getByText("@bob:chat.example")).toBeTruthy();
    expect(screen.getByText("@cara:chat.example")).toBeTruthy();
    expect(screen.getByText("@remy:far.example")).toBeTruthy();
  });

  it("leaves out friends who are already members", () => {
    open({ members: [owner, bob] });

    expect(screen.queryByText("@bob:chat.example")).toBeNull();
    expect(screen.getByText("@cara:chat.example")).toBeTruthy();
  });

  it("filters by name or identity", () => {
    open();

    fireEvent.change(screen.getByLabelText("Search friends"), { target: { value: "far.exa" } });

    expect(screen.getByText("@remy:far.example")).toBeTruthy();
    expect(screen.queryByText("@bob:chat.example")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search friends"), { target: { value: "zzz" } });
    expect(screen.getByText("No friend matches.")).toBeTruthy();
  });

  it("says so when you have no friends, and points at the code", () => {
    open({ friends: [] });

    expect(screen.getByText(/no friends to invite yet/)).toBeTruthy();
    expect(screen.queryByLabelText("Search friends")).toBeNull();
  });

  it("says so when every friend is already in", () => {
    open({ members: [owner, bob, cara, remy] });

    expect(screen.getByText("All your friends are already in Book Club.")).toBeTruthy();
  });

  describe("banned friends", () => {
    it("are left out for someone who can see the ban list", async () => {
      listCommunityBans.mockResolvedValue([{ user: bob, reason: null, createdAt: "" }]);
      open(); // the owner can ban, so can see who is banned

      await waitFor(() => expect(screen.queryByText("@bob:chat.example")).toBeNull());
      expect(listCommunityBans).toHaveBeenCalledWith("01JCOMMUNITY");
      expect(screen.getByText("@cara:chat.example")).toBeTruthy();
    });

    // Without that permission they cannot be told apart, and must not be looked up.
    it("are not looked up for someone who cannot see the ban list", () => {
      open({ viewer: viewerPlain, members: [owner, { ...person("plain", "plain") }] });

      expect(listCommunityBans).not.toHaveBeenCalled();
      expect(screen.getByText("@bob:chat.example")).toBeTruthy();
    });

    it("still lists everyone if the ban list cannot be loaded", async () => {
      listCommunityBans.mockRejectedValue(new Error("nope"));
      open();

      await waitFor(() => expect(listCommunityBans).toHaveBeenCalled());
      expect(screen.getByText("@bob:chat.example")).toBeTruthy();
    });
  });
});

describe("InviteModal: inviting a friend", () => {
  const row = (name: string) => screen.getByText(name).closest(".friend-request-row") as HTMLElement;

  it("sends the invitation and shows the friend as invited", async () => {
    open();

    fireEvent.click(within(row("@bob:chat.example")).getByRole("button", { name: "Invite Bob" }));

    await waitFor(() => expect(within(row("@bob:chat.example")).getByRole("button").textContent).toBe("Invited"));
    expect(inviteToCommunity).toHaveBeenCalledWith("01JCOMMUNITY", bob);
    expect((within(row("@bob:chat.example")).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("invites a friend on another server the same way", async () => {
    open();

    fireEvent.click(within(row("@remy:far.example")).getByRole("button", { name: "Invite Remy" }));

    await waitFor(() => expect(inviteToCommunity).toHaveBeenCalledWith("01JCOMMUNITY", remy));
  });

  it("invites one friend at a time, leaving the others to invite", async () => {
    open();

    fireEvent.click(within(row("@bob:chat.example")).getByRole("button", { name: "Invite Bob" }));
    await waitFor(() => expect(within(row("@bob:chat.example")).getByRole("button").textContent).toBe("Invited"));

    expect(within(row("@cara:chat.example")).getByRole("button").textContent).toBe("Invite");
    expect(inviteToCommunity).toHaveBeenCalledOnce();
  });

  it("is busy while sending, and cannot be pressed again", async () => {
    let finish: (v: unknown) => void = () => {};
    inviteToCommunity.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    open();

    fireEvent.click(within(row("@bob:chat.example")).getByRole("button", { name: "Invite Bob" }));

    const button = await waitFor(() => {
      const b = within(row("@bob:chat.example")).getByRole("button") as HTMLButtonElement;
      expect(b.getAttribute("aria-busy")).toBe("true");
      return b;
    });
    expect(button.disabled).toBe(true);
    finish({});
  });

  it("says it could not send, and offers to try again, which works", async () => {
    inviteToCommunity.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({});
    open();

    fireEvent.click(within(row("@bob:chat.example")).getByRole("button", { name: "Invite Bob" }));
    await screen.findByText("Couldn't send");
    expect(within(row("@bob:chat.example")).getByRole("button").textContent).toBe("Try again");

    fireEvent.click(within(row("@bob:chat.example")).getByRole("button", { name: "Invite Bob" }));
    await waitFor(() => expect(within(row("@bob:chat.example")).getByRole("button").textContent).toBe("Invited"));
    expect(screen.queryByText("Couldn't send")).toBeNull();
  });

  it("closes with Done", () => {
    const { onClose } = open();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
