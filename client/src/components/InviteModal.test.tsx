import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community, Invite, PublicUser } from "../api";
import { ApiError } from "../api/client";
import { resetFederationState, setFederationEnabled } from "../lib/federation";
import InviteModal from "./InviteModal";

const inviteToCommunity = vi.fn();
const listCommunityBans = vi.fn();
const listInvites = vi.fn();
const createInvite = vi.fn();
const revokeInvite = vi.fn();
vi.mock("../api", () => ({
  inviteToCommunity: (...args: unknown[]) => inviteToCommunity(...args),
  listCommunityBans: (...args: unknown[]) => listCommunityBans(...args),
  listInvites: (...args: unknown[]) => listInvites(...args),
  createInvite: (...args: unknown[]) => createInvite(...args),
  revokeInvite: (...args: unknown[]) => revokeInvite(...args),
}));

const appData = vi.hoisted(() => ({ value: { friends: [] as unknown[] } }));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => appData.value }));

const person = (id: string, name: string, domain = "chat.example") =>
  ({ id, identity: `@${name}:${domain}`, username: name, displayName: name[0].toUpperCase() + name.slice(1), avatarUrl: null }) as PublicUser;

const owner = person("owner", "olive");
const bob = person("bob", "bob");
const cara = person("cara", "cara");
const remy = person("remy", "remy", "far.example"); // a friend on another server

// SEND_MESSAGES | REACT, and with CREATE_INVITE (bit 9) as every community's @everyone role has it by default.
const EVERYONE_WITH_INVITE = String(128 + 256 + 512);
const EVERYONE_WITHOUT_INVITE = String(128 + 256);

function community(
  options: {
    members?: PublicUser[];
    openJoin?: boolean | undefined;
    visibility?: Community["visibility"];
    everyone?: string;
    homeserverDomain?: string;
    noRoles?: boolean;
  } = {}
): Community {
  const members = options.members ?? [owner];
  return {
    id: "01JCOMMUNITY",
    name: "Book Club",
    homeserverDomain: options.homeserverDomain ?? "chat.example",
    ...("openJoin" in options ? { openJoin: options.openJoin } : { openJoin: true }),
    ...(options.visibility ? { visibility: options.visibility } : {}),
    owner,
    // A community on another server is cached without its roles (only its structure is sent), so a test of one says noRoles.
    roles: options.noRoles
      ? []
      : [{ id: "every", name: "@everyone", color: null, position: 0, permissions: options.everyone ?? EVERYONE_WITH_INVITE, isDefault: true }],
    members: members.map((m) => ({ ...m, roleIds: options.noRoles ? [] : ["every"] })),
    channels: [],
  } as unknown as Community;
}

const viewerOwner = { id: owner.id, identity: owner.identity };
const viewerBob = { id: bob.id, identity: bob.identity };

function invite(over: Partial<Invite> = {}): Invite {
  return {
    id: "inv1",
    code: "K7M2QXR9TB",
    reference: "01JCOMMUNITY:chat.example#K7M2QXR9TB",
    expiresAt: new Date(Date.now() + 3 * 86_400_000 - 5000).toISOString(),
    maxUses: 5,
    uses: 2,
    revokedAt: null,
    viaCard: false,
    status: "active",
    createdAt: new Date().toISOString(),
    createdBy: owner,
    ...over,
  };
}

function open(
  options: {
    members?: PublicUser[];
    friends?: PublicUser[];
    viewer?: { id: string; identity: string };
    community?: Parameters<typeof community>[0];
  } = {}
) {
  appData.value = { friends: options.friends ?? [bob, cara, remy] };
  const onClose = vi.fn();
  render(
    <InviteModal
      community={community({ members: options.members, ...options.community })}
      viewer={options.viewer ?? viewerOwner}
      onClose={onClose}
    />
  );
  return { onClose };
}

const writeText = vi.fn();
beforeEach(() => {
  writeText.mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  inviteToCommunity.mockResolvedValue({});
  listCommunityBans.mockResolvedValue([]);
  listInvites.mockResolvedValue({ invites: [], seesAll: false });
  createInvite.mockResolvedValue(invite());
  revokeInvite.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const settled = () => waitFor(() => expect(listInvites).toHaveBeenCalled());

describe("InviteModal: the community code", () => {
  it("shows the code that joins from any server: the id and where it lives", () => {
    open();

    expect(screen.getByRole("dialog", { name: "Invite to Book Club" })).toBeTruthy();
    expect((screen.getByLabelText("Community code") as HTMLInputElement).value).toBe("01JCOMMUNITY:chat.example");
    expect((screen.getByLabelText("Community code") as HTMLInputElement).readOnly).toBe(true);
  });

  it("copies it, and says so", async () => {
    open();

    fireEvent.click(screen.getByRole("button", { name: "Copy community code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("01JCOMMUNITY:chat.example"));
    expect(await screen.findByText("Copied to the clipboard.")).toBeTruthy();
  });

  it("does not claim it copied when the clipboard is not available", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    open();

    fireEvent.click(screen.getByRole("button", { name: "Copy community code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByText("Copied to the clipboard.")).toBeNull();
  });

  it("is not shown for an invite-only community, whose code would let no one in, and says so", () => {
    open({ community: { openJoin: false } });

    expect(screen.queryByLabelText("Community code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy community code" })).toBeNull();
    expect(screen.getByText(/invite-only, so its community code lets no one in/)).toBeTruthy();
  });

  it("is shown for a server that does not say, which has always been open", () => {
    open({ community: { openJoin: undefined } });

    expect(screen.getByLabelText("Community code")).toBeTruthy();
  });
});

describe("InviteModal: making an invite", () => {
  it("offers an expiry and a limit, starting at 7 days and no limit", () => {
    open();

    expect((screen.getByLabelText("Expires after") as HTMLSelectElement).selectedOptions[0].textContent).toBe("7 days");
    expect((screen.getByLabelText("Limit") as HTMLSelectElement).selectedOptions[0].textContent).toBe("No limit");
    expect([...(screen.getByLabelText("Expires after") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["1 hour", "24 hours", "7 days", "Never"]);
    expect([...(screen.getByLabelText("Limit") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      "No limit",
      "1 use",
      "5 uses",
      "10 uses",
      "25 uses",
      "50 uses",
      "100 uses",
    ]);
  });

  it("makes one with the chosen expiry and limit, and shows the code to copy", async () => {
    createInvite.mockResolvedValue(invite({ expiresAt: new Date(Date.now() + 3600_000 - 5000).toISOString(), maxUses: 5, uses: 0 }));
    open();
    fireEvent.change(screen.getByLabelText("Expires after"), { target: { value: "3600" } });
    fireEvent.change(screen.getByLabelText("Limit"), { target: { value: "5" } });

    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));

    await waitFor(() => expect(createInvite).toHaveBeenCalledWith("01JCOMMUNITY", { expiresInSeconds: 3600, maxUses: 5 }));
    expect((await screen.findByLabelText("New invite") as HTMLInputElement).value).toBe("01JCOMMUNITY:chat.example#K7M2QXR9TB");
    expect(screen.getByText(/Expires in 1 hour · 5 people can use it/)).toBeTruthy();
  });

  it("can make one that never expires and has no limit, sending nulls rather than leaving them out", async () => {
    createInvite.mockResolvedValue(invite({ expiresAt: null, maxUses: null }));
    open();
    fireEvent.change(screen.getByLabelText("Expires after"), { target: { value: "null" } });

    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));

    await waitFor(() => expect(createInvite).toHaveBeenCalledWith("01JCOMMUNITY", { expiresInSeconds: null, maxUses: null }));
    expect(await screen.findByText(/Never expires · Any number of people can use it/)).toBeTruthy();
  });

  it("copies the new invite as the full reference, which works from any server", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    await screen.findByLabelText("New invite");

    fireEvent.click(screen.getByRole("button", { name: "Copy invite" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("01JCOMMUNITY:chat.example#K7M2QXR9TB"));
    expect(await screen.findByText("Copied to the clipboard.")).toBeTruthy();
  });

  it("says it could not, keeps the options, and can be tried again", async () => {
    createInvite.mockRejectedValueOnce(new Error("500"));
    open();
    fireEvent.change(screen.getByLabelText("Limit"), { target: { value: "10" } });

    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't make an invite");
    expect((screen.getByLabelText("Limit") as HTMLSelectElement).value).toBe("10");
    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(createInvite).toHaveBeenCalledTimes(2);
    expect(await screen.findByLabelText("New invite")).toBeTruthy();
  });

  it("is busy while making it, so one press makes one invite", async () => {
    let finish!: (value: Invite) => void;
    createInvite.mockReturnValue(new Promise<Invite>((resolve) => (finish = resolve)));
    open();

    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Create invite" }).getAttribute("aria-busy")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    expect(createInvite).toHaveBeenCalledOnce();
    finish(invite());
    await screen.findByLabelText("New invite");
  });

  it("is open to a member who holds CREATE_INVITE, which everyone does by default", () => {
    open({ members: [owner, bob], viewer: viewerBob });

    expect(screen.getByRole("button", { name: "Create invite" })).toBeTruthy();
  });

  it("offers nothing to a member whose role lacks CREATE_INVITE, and says why, for invites and for friends", () => {
    open({ members: [owner, bob], viewer: viewerBob, community: { everyone: EVERYONE_WITHOUT_INVITE } });

    expect(screen.queryByRole("button", { name: "Create invite" })).toBeNull();
    expect(screen.getByText("You don't have permission to create invites in this community.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite Bob" })).toBeNull();
    expect(screen.getByText(/can't invite friends here without permission/)).toBeTruthy();
  });

  it("is always open to the owner, whatever the roles say", () => {
    open({ community: { everyone: EVERYONE_WITHOUT_INVITE } });

    expect(screen.getByRole("button", { name: "Create invite" })).toBeTruthy();
  });
});

describe("InviteModal: the list of invites", () => {
  it("loads them from the home server and shows each with its code, status, expiry and uses", async () => {
    listInvites.mockResolvedValue({ invites: [invite()], seesAll: false });
    open();

    expect(await screen.findByText("K7M2QXR9TB")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(/Expires in 3 days · 2 of 5 used/)).toBeTruthy();
    expect(listInvites).toHaveBeenCalledWith("01JCOMMUNITY");
  });

  it("says Your invites, or All invites for someone who sees everyone's, and names who made the others", async () => {
    listInvites.mockResolvedValue({
      invites: [invite(), invite({ id: "inv2", code: "BBBBBBBBBB", createdBy: bob, maxUses: null, uses: 1 })],
      seesAll: true,
    });
    open();

    expect(await screen.findByText("All invites")).toBeTruthy();
    expect(screen.getByText(/by Bob/)).toBeTruthy();
    expect(screen.getByText(/1 use$/)).toBeTruthy();
    // an invite you made yourself is not labelled with your own name
    expect(screen.queryByText(/by Olive/)).toBeNull();
  });

  it("says Your invites when only their own are shown", async () => {
    listInvites.mockResolvedValue({ invites: [invite()], seesAll: false });
    open();

    expect(await screen.findByText("Your invites")).toBeTruthy();
  });

  it("shows an invite that has ended with its reason, and no buttons to use or revoke it", async () => {
    listInvites.mockResolvedValue({
      invites: [
        invite({ id: "a", code: "AAAAAAAAAA", status: "expired", expiresAt: new Date(Date.now() - 1000).toISOString() }),
        invite({ id: "b", code: "BBBBBBBBBB", status: "revoked", revokedAt: new Date().toISOString() }),
        invite({ id: "c", code: "CCCCCCCCCC", status: "used_up", uses: 5 }),
      ],
      seesAll: false,
    });
    open();

    await screen.findByText("AAAAAAAAAA");
    expect(screen.getByText("Expired", { selector: ".invite-status" })).toBeTruthy();
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.getByText("Used up")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Revoke invite/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy invite A/ })).toBeNull();
  });

  // A revoked invite whose time has also passed used to say "Expired" under a "Revoked" badge.
  it("shows only the uses for an ended invite, so the details never contradict the badge", async () => {
    listInvites.mockResolvedValue({
      invites: [invite({ status: "revoked", revokedAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(), uses: 1, maxUses: 1 })],
      seesAll: false,
    });
    open();

    await screen.findByText("Revoked");

    const row = document.querySelector(".invite-row") as HTMLElement;
    expect(within(row).getByText("1 of 1 used")).toBeTruthy();
    expect(within(row).queryByText(/Expired|Expires in|Never expires/)).toBeNull();
  });

  it("says so when there are none, while loading, and when they cannot be loaded", async () => {
    let fail!: (e: Error) => void;
    listInvites.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    open();
    expect(screen.getByText("Loading…")).toBeTruthy();

    fail(new Error("500"));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the invites");
  });

  it("says there are none yet when the list is empty", async () => {
    open();

    expect(await screen.findByText("No invites yet.")).toBeTruthy();
  });

  it("copies an invite from the list as the full reference", async () => {
    listInvites.mockResolvedValue({ invites: [invite()], seesAll: false });
    open();
    await screen.findByText("K7M2QXR9TB");

    fireEvent.click(screen.getByRole("button", { name: "Copy invite K7M2QXR9TB" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("01JCOMMUNITY:chat.example#K7M2QXR9TB"));
  });

  it("is read again after an invite is made, so the new one is in it", async () => {
    open();
    await settled();

    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));

    await waitFor(() => expect(listInvites).toHaveBeenCalledTimes(2));
  });
});

describe("InviteModal: revoking an invite", () => {
  async function openWithOne() {
    listInvites.mockResolvedValue({ invites: [invite()], seesAll: false });
    open();
    await screen.findByText("K7M2QXR9TB");
  }

  it("asks first, and revokes it by id when confirmed, then reads the list again", async () => {
    await openWithOne();

    fireEvent.click(screen.getByRole("button", { name: "Revoke invite K7M2QXR9TB" }));
    expect(revokeInvite).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Revoke invite" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(revokeInvite).toHaveBeenCalledWith("01JCOMMUNITY", "inv1"));
    await waitFor(() => expect(listInvites).toHaveBeenCalledTimes(2));
  });

  it("does nothing when the question is cancelled", async () => {
    await openWithOne();

    fireEvent.click(screen.getByRole("button", { name: "Revoke invite K7M2QXR9TB" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Revoke invite" })).getByRole("button", { name: "Cancel" }));

    expect(revokeInvite).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Revoke invite" })).toBeNull();
  });

  it("says when it could not be revoked", async () => {
    revokeInvite.mockRejectedValue(new Error("403"));
    await openWithOne();

    fireEvent.click(screen.getByRole("button", { name: "Revoke invite K7M2QXR9TB" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Revoke invite" })).getByRole("button", { name: "Revoke" }));

    expect((await screen.findByText("Couldn't revoke that invite.")).getAttribute("role")).toBe("alert");
  });

  it("takes the new invite away from view when that very one is revoked", async () => {
    listInvites.mockResolvedValue({ invites: [invite()], seesAll: false });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    await screen.findByLabelText("New invite");

    fireEvent.click(await screen.findByRole("button", { name: "Revoke invite K7M2QXR9TB" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Revoke invite" })).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(screen.queryByLabelText("New invite")).toBeNull());
  });
});

describe("InviteModal: a community on another server", () => {
  // As in the real cache: no roles, so the viewer's permissions cannot be worked out here; the home server decides.
  const far = { community: { homeserverDomain: "far.example", noRoles: true } };

  it("offers to make an invite even though the roles are not known here, since the home server decides", () => {
    open({ ...far, members: [owner, bob], viewer: viewerBob });

    expect(screen.getByRole("button", { name: "Create invite" })).toBeTruthy();
    expect(screen.queryByText("You don't have permission to create invites in this community.")).toBeNull();
  });

  it("offers to invite friends too, which the home server also checks", () => {
    open({ ...far, members: [owner, bob], viewer: viewerBob });

    expect(screen.getByRole("button", { name: "Invite Cara" })).toBeTruthy();
  });

  it("says so when the home server refuses, which is how a member without the permission finds out", async () => {
    createInvite.mockRejectedValue(new ApiError(403, { error: "forbidden" }));
    open({ ...far, members: [owner, bob], viewer: viewerBob });

    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));

    expect((await screen.findByRole("alert")).textContent).toBe("You don't have permission to create invites in this community.");
    expect(screen.queryByLabelText("New invite")).toBeNull();
  });

  it("does not ask this server for the invites, which only the home server keeps, and says where they are", () => {
    open(far);

    expect(listInvites).not.toHaveBeenCalled();
    expect(screen.getByText(/listed and revoked on far\.example/)).toBeTruthy();
    expect(screen.queryByText("Your invites")).toBeNull();
  });

  it("still makes an invite, shows its code, and offers no way to revoke what it cannot list", async () => {
    createInvite.mockResolvedValue(invite({ id: null, reference: "01JCOMMUNITY:far.example#K7M2QXR9TB" }));
    open(far);

    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));

    expect(((await screen.findByLabelText("New invite")) as HTMLInputElement).value).toBe("01JCOMMUNITY:far.example#K7M2QXR9TB");
    expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();
    expect(listInvites).not.toHaveBeenCalled();
  });

  it("shows its community code with the other server in it", () => {
    open(far);

    expect((screen.getByLabelText("Community code") as HTMLInputElement).value).toBe("01JCOMMUNITY:far.example");
  });
});

describe("InviteModal: who can be invited", () => {
  it("lists friends who are not in the community, on this server or another", () => {
    open();

    expect(screen.getByRole("button", { name: "Invite Bob" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite Cara" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite Remy" })).toBeTruthy();
  });

  it("leaves out friends who are already members", () => {
    open({ members: [owner, bob] });

    expect(screen.queryByRole("button", { name: "Invite Bob" })).toBeNull();
    expect(screen.getByRole("button", { name: "Invite Cara" })).toBeTruthy();
  });

  it("filters by name or identity", () => {
    open();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search friends" }), { target: { value: "far.example" } });

    expect(screen.queryByRole("button", { name: "Invite Bob" })).toBeNull();
    expect(screen.getByRole("button", { name: "Invite Remy" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search friends" }), { target: { value: "zzz" } });
    expect(screen.getByText("No friend matches.")).toBeTruthy();
  });

  it("says so when you have no friends, and points at invites", () => {
    open({ friends: [] });

    expect(screen.getByText(/You have no friends to invite yet. Share an invite instead./)).toBeTruthy();
  });

  it("says so when every friend is already in", () => {
    open({ members: [owner, bob, cara, remy] });

    expect(screen.getByText("All your friends are already in Book Club.")).toBeTruthy();
  });

  it("says what a friend gets: a card with an invitation that works once, for a week", () => {
    open();

    expect(screen.getByText("Sends a direct message with an invitation that can be used once and lasts a week.")).toBeTruthy();
  });

  describe("banned friends", () => {
    it("are left out for someone who can see the ban list", async () => {
      listCommunityBans.mockResolvedValue([{ user: bob }]);
      open();

      await waitFor(() => expect(screen.queryByRole("button", { name: "Invite Bob" })).toBeNull());
      expect(screen.getByRole("button", { name: "Invite Cara" })).toBeTruthy();
    });

    it("are not looked up for someone who cannot see the ban list", () => {
      open({ members: [owner, bob], viewer: viewerBob });

      expect(listCommunityBans).not.toHaveBeenCalled();
    });

    it("still lists everyone if the ban list cannot be loaded", async () => {
      listCommunityBans.mockRejectedValue(new Error("500"));
      open();

      await waitFor(() => expect(listCommunityBans).toHaveBeenCalled());
      expect(screen.getByRole("button", { name: "Invite Bob" })).toBeTruthy();
    });
  });
});

describe("InviteModal: inviting a friend", () => {
  const sentTo = (name: string) => screen.getByRole("button", { name: `Invite ${name}` });

  it("sends the invitation and shows the friend as invited", async () => {
    open();

    fireEvent.click(sentTo("Bob"));

    await waitFor(() => expect(inviteToCommunity).toHaveBeenCalledWith("01JCOMMUNITY", bob));
    await waitFor(() => expect(sentTo("Bob").textContent).toBe("Invited"));
    expect((sentTo("Bob") as HTMLButtonElement).disabled).toBe(true);
  });

  it("invites a friend on another server the same way", async () => {
    open();

    fireEvent.click(sentTo("Remy"));

    await waitFor(() => expect(inviteToCommunity).toHaveBeenCalledWith("01JCOMMUNITY", remy));
  });

  it("invites one friend at a time, leaving the others to invite", async () => {
    open();

    fireEvent.click(sentTo("Bob"));
    await waitFor(() => expect(sentTo("Bob").textContent).toBe("Invited"));

    expect(sentTo("Cara").textContent).toBe("Invite");
    expect((sentTo("Cara") as HTMLButtonElement).disabled).toBe(false);
  });

  it("is busy while sending, and cannot be pressed again", async () => {
    let finish!: () => void;
    inviteToCommunity.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    open();

    fireEvent.click(sentTo("Bob"));
    await waitFor(() => expect(sentTo("Bob").getAttribute("aria-busy")).toBe("true"));
    fireEvent.click(sentTo("Bob"));
    expect(inviteToCommunity).toHaveBeenCalledOnce();

    finish();
    await waitFor(() => expect(sentTo("Bob").textContent).toBe("Invited"));
  });

  it("says it could not send, and offers to try again, which works", async () => {
    inviteToCommunity.mockRejectedValueOnce(new Error("500"));
    open();

    fireEvent.click(sentTo("Bob"));
    expect(await screen.findByText("Couldn't send")).toBeTruthy();
    expect(sentTo("Bob").textContent).toBe("Try again");
    fireEvent.click(sentTo("Bob"));

    await waitFor(() => expect(sentTo("Bob").textContent).toBe("Invited"));
    expect(screen.queryByText("Couldn't send")).toBeNull();
  });

  it("closes with Done", () => {
    const { onClose } = open();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("InviteModal: on a private server", () => {
  afterEach(() => resetFederationState());

  it("cannot invite a friend on another server, and says that is why, while friends here can still be invited", () => {
    setFederationEnabled(false);
    open();

    expect((screen.getByRole("button", { name: "Invite Remy" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("@remy:far.example (another server)")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Invite Bob" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("@bob:chat.example")).toBeTruthy();
  });

  it("invites a friend on another server as usual when federation is on", () => {
    open();

    expect((screen.getByRole("button", { name: "Invite Remy" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("InviteModal: a community that takes only people on its own server", () => {
  const localOnly = { visibility: "LOCAL_ONLY" as const };

  it("still shows the community code, and says who it works for", () => {
    open({ community: localOnly });

    expect((screen.getByLabelText("Community code") as HTMLInputElement).value).toBe("01JCOMMUNITY:chat.example");
    expect(screen.getByText(/only takes people on chat.example, so only they can join with it/)).toBeTruthy();
  });

  it("leaves a friend on another server out of the invitable ones, saying why, and lets a friend on its server be invited", () => {
    open({ community: localOnly });

    expect(screen.getByText("@remy:far.example (only people on chat.example can join)")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Invite Remy" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Invite Bob" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("lets a friend on another server be invited to every other kind of community", () => {
    open({ community: { visibility: "UNLISTED" } });

    expect((screen.getByRole("button", { name: "Invite Remy" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says so when the home server refuses an invite for that reason", async () => {
    createInvite.mockRejectedValue(new ApiError(403, { error: "community_local_only" }));
    open({ community: localOnly });

    fireEvent.click(screen.getByRole("button", { name: /Create invite/ }));

    expect(await screen.findByText(/Only people on this community's server can join it/)).toBeTruthy();
  });
});
