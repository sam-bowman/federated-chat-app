import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Community } from "../api";
import { ROLE_PERMISSIONS } from "../lib/permissions";
import { UserProfileContext } from "../context/userProfile";
import CommunitySettingsModal from "./CommunitySettingsModal";

vi.mock("../api", () => ({ listCommunityBans: () => Promise.resolve([]) }));
vi.mock("../context/AppDataContext", () => ({ useAppData: () => ({ refreshCommunities: vi.fn() }) }));

afterEach(cleanup);

const bit = (key: string) => ROLE_PERMISSIONS.find((p) => p.key === key)!.bit;
const perms = (...keys: string[]) => keys.reduce((all, k) => all | bit(k), 0n).toString();
const user = (id: string, domain = "chat.example") => ({
  id,
  identity: `@${id}:${domain}`,
  username: id,
  displayName: id,
  avatarUrl: null,
});

const community = {
  id: "C1",
  name: "Club",
  description: null,
  owner: user("owner"),
  channels: [{ id: "ch1", name: "general", topic: null, position: 0, unread: false }],
  roles: [
    { id: "every", name: "@everyone", color: null, position: 0, permissions: perms("SEND_MESSAGES"), isDefault: true },
    { id: "kick", name: "Kicker", color: null, position: 1, permissions: perms("KICK_MEMBERS"), isDefault: false },
    { id: "ban", name: "Banner", color: null, position: 2, permissions: perms("BAN_MEMBERS"), isDefault: false },
    { id: "roles", name: "RoleMaker", color: null, position: 3, permissions: perms("MANAGE_ROLES", "KICK_MEMBERS"), isDefault: false },
    { id: "chan", name: "ChannelMaker", color: null, position: 4, permissions: perms("MANAGE_CHANNELS"), isDefault: false },
    { id: "gen", name: "Namer", color: null, position: 5, permissions: perms("MANAGE_COMMUNITY"), isDefault: false },
  ],
  members: [
    { ...user("owner"), roleIds: ["every"] },
    { ...user("kicker"), roleIds: ["every", "kick"] },
    { ...user("banner"), roleIds: ["every", "ban"] },
    { ...user("roler"), roleIds: ["every", "roles"] },
    { ...user("channeler"), roleIds: ["every", "chan"] },
    { ...user("namer"), roleIds: ["every", "gen"] },
    { ...user("victim"), roleIds: ["every"] },
  ],
} as unknown as Community;

function open(viewerId: string, domain?: string) {
  render(<CommunitySettingsModal community={community} viewer={user(viewerId, domain)} onClose={() => {}} />);
}

const tabNames = () => Array.from(document.querySelectorAll(".tab")).map((t) => t.textContent);
const row = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(".friend-request-row")).find((r) => r.textContent?.includes(name))!;

describe("CommunitySettingsModal for a delegated member", () => {
  it("shows the owner every tab", () => {
    open("owner");
    expect(tabNames()).toEqual(["General", "Members (7)", "Channels", "Roles", "Banned"]);
  });

  it("shows a member with only Kick members just the Members tab, with Kick but no Ban or role chips", () => {
    open("kicker");

    expect(tabNames()).toEqual(["Members (7)"]);
    const victim = row("victim");
    expect(victim.textContent).toContain("Kick");
    expect(victim.textContent).not.toContain("Ban");
    expect(screen.queryByRole("button", { name: "Kicker" })).toBeNull();
  });

  it("shows a member with only Ban members the Members and Banned tabs, with Ban but no Kick", () => {
    open("banner");

    expect(tabNames()).toEqual(["Members (7)", "Banned"]);
    expect(row("victim").textContent).toContain("Ban");
    expect(row("victim").textContent).not.toContain("Kick");
  });

  it("opens straight onto the first tab the viewer is allowed", () => {
    open("channeler");
    expect(tabNames()).toEqual(["Channels"]);
    expect(document.querySelector(".tab.active")!.textContent).toBe("Channels");
  });

  it("shows Manage community only the General tab", () => {
    open("namer");
    expect(tabNames()).toEqual(["General"]);
    expect(screen.getByDisplayValue("Club")).not.toBeNull();
  });

  it("gives Manage roles the Members tab (for role chips) and the Roles tab, nothing else", () => {
    open("roler");
    expect(tabNames()).toEqual(["Members (7)", "Roles"]);
  });

  it("never offers kick or ban on the owner or on yourself", () => {
    open("kicker");
    expect(row("owner").textContent).not.toContain("Kick");
    expect(row("kicker").textContent).not.toContain("Kick");
  });

  it("disables role chips the viewer could not give anyway (they are made of permissions the viewer lacks)", () => {
    open("roler");

    // RoleMaker holds Manage roles + Kick members, so only a role within those is theirs to give.
    expect((screen.getAllByRole("button", { name: /Kicker/ })[0] as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getAllByRole("button", { name: /Banner/ })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: /Namer/ })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows nothing to manage for a community on another server", () => {
    const remote = { ...community, owner: user("far", "other.example") } as unknown as Community;
    render(<CommunitySettingsModal community={remote} viewer={user("roler")} onClose={() => {}} />);
    expect(tabNames()).toEqual([]);
  });
});

describe("CommunitySettingsModal - the danger zone", () => {
  it("shows the owner transfer and delete under General", () => {
    open("owner");
    expect(screen.getByRole("region", { name: "Danger zone" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Delete community…" })).not.toBeNull();
  });

  it("does not show it to a delegated manager who can open General", () => {
    open("namer"); // holds Manage community, and nothing else
    expect(screen.getByDisplayValue("Club")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Danger zone" })).toBeNull();
  });

  it("keeps the dialogs out of the settings form, so submitting one can't save the other", () => {
    open("owner");
    fireEvent.click(screen.getByRole("button", { name: "Delete community…" }));
    const dialogForm = screen.getByLabelText("Type the community's name to confirm").closest("form")!;
    expect(dialogForm.parentElement!.closest("form")).toBeNull();
  });
});

describe("members in community settings open their profile", () => {
  it("from their picture or name, with the community so their roles show", () => {
    const openProfile = vi.fn();
    render(
      <UserProfileContext.Provider value={{ openProfile }}>
        <CommunitySettingsModal community={community} viewer={user("owner")} onClose={() => {}} />
      </UserProfileContext.Provider>
    );
    const victim = community.members.find((m) => m.id === "victim")!;
    fireEvent.click(screen.getByRole("tab", { name: /Members/ }));

    fireEvent.click(screen.getByRole("button", { name: "View victim's profile" }));
    fireEvent.click(within(row("victim")).getAllByRole("button", { name: "victim" })[0]);

    expect(openProfile).toHaveBeenCalledTimes(2);
    expect(openProfile).toHaveBeenNthCalledWith(1, victim, { communityId: "C1" });
    expect(openProfile).toHaveBeenNthCalledWith(2, victim, { communityId: "C1" });
  });
});

describe("CommunitySettingsModal: joining", () => {
  it("shows the owner the switch for making the community invite-only, under General", () => {
    open("owner");

    expect(screen.getByRole("checkbox", { name: "Anyone with the community code can join" })).toBeTruthy();
  });

  it("shows it to a manager of the community, and not to a member who only kicks or bans", () => {
    open("namer");
    expect(screen.getByRole("checkbox", { name: "Anyone with the community code can join" })).toBeTruthy();
    cleanup();

    open("kicker");
    expect(screen.queryByRole("checkbox", { name: "Anyone with the community code can join" })).toBeNull();
  });
});
