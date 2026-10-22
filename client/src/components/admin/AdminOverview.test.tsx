import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminOverview as Overview } from "../../api";
import AdminOverview from "./AdminOverview";

const mocks = vi.hoisted(() => ({ getAdminOverview: vi.fn() }));
vi.mock("../../api", () => ({ getAdminOverview: mocks.getAdminOverview }));

const base = (): Overview => ({
  generatedAt: "2026-06-01T12:00:00.000Z",
  server: { name: "Bowmans Chat", domain: "chat.example", version: "0.17.0", storage: "disk", redis: true },
  registration: { enabled: true, inviteOnly: true, activeInvites: 3 },
  features: { federation: true, voice: true, directory: false, linkPreviews: true },
  federation: { enabled: true, allowedServers: 0, blockedServers: 0, knownServers: 4, queue: { pending: 0, retrying: 0, inProgress: 0, failed: 0, oldestPendingAt: null } },
  people: { total: 12, activeLastDay: 5, activeLastWeek: 8, activeLastMonth: 10, joinedLastWeek: 2, suspended: 1, deletionPending: 4, admins: 2, withoutTwoFactor: 9 },
  communities: { hosted: 6, copiesOfOthers: 2, memberships: 30, textChannels: 14, voiceChannels: 3, byVisibility: { UNLISTED: 3, PUBLIC: 1, INVITE_ONLY: 2, LOCAL_ONLY: 0 } },
  auditEntriesLastDay: 1,
  settings: [
    { setting: "ACCOUNT_DELETION_GRACE_DAYS", value: "14" },
    { setting: "AUDIT_LOG_RETENTION_DAYS", value: "0" },
    { setting: "MAX_UPLOAD_BYTES", value: "8388608" },
  ],
});
const withOverview = (change: (o: Overview) => void) => {
  const o = base();
  change(o);
  mocks.getAdminOverview.mockResolvedValue({ overview: o });
};
const card = (name: string) => screen.findByRole("region", { name });
const text = async (name: string) => (await card(name)).textContent!;

beforeEach(() => mocks.getAdminOverview.mockReset().mockResolvedValue({ overview: base() }));
afterEach(cleanup);

describe("the overview", () => {
  it("says what the server is", async () => {
    render(<AdminOverview />);
    const server = await text("Server");
    expect(server).toContain("Bowmans Chat");
    expect(server).toContain("chat.example");
    expect(server).toContain("0.17.0");
    expect(server).toContain("On the server's disk");
    expect(server).toContain("Shared between replicas (Redis)");
  });

  it("says the other ways the server can be run", async () => {
    withOverview((o) => {
      o.server.storage = "s3";
      o.server.redis = false;
    });
    render(<AdminOverview />);
    const server = await text("Server");
    expect(server).toContain("In S3 storage");
    expect(server).toContain("This process only");
  });

  it("says how many people there are and how lately they have been seen, and what state they are in", async () => {
    render(<AdminOverview />);
    const people = await text("People");
    expect(people).toContain("Accounts12");
    expect(people).toContain("5 in the last day, 8 in the last week, 10 in the last month");
    expect(people).toContain("Joined in the last week2");
    expect(people).toContain("Admins2");
    expect(people).toContain("Suspended1");
    expect(people).toContain("Being deleted4");
    expect(people).toContain("Without two-factor9");
  });

  it("says how many communities, how big, and who can join each, in the words Settings uses, and copies of other servers' apart", async () => {
    render(<AdminOverview />);
    const communities = await text("Communities");
    expect(communities).toContain("Hosted here6");
    expect(communities).toContain("Memberships30");
    expect(communities).toContain("14 text, 3 voice");
    expect(communities).toContain("Anyone with the community code3");
    expect(communities).toContain("Public: listed in the directory1");
    expect(communities).toContain("Only people with an invite2");
    expect(communities).toContain("Only people on this server0");
    expect(communities).toContain("Copies of communities on other servers2");
  });

  it("says who can register, and for an invite-only server how many codes can still be used", async () => {
    render(<AdminOverview />);
    const registration = await text("Registration");
    expect(registration).toContain("Only people with an invite code");
    expect(registration).toContain("3 codes can still be used");
  });

  it("says when no code can be used, which means nobody can register", async () => {
    withOverview((o) => (o.registration.activeInvites = 0));
    render(<AdminOverview />);
    expect(await text("Registration")).toContain("None can be used: nobody can register");
  });

  it("says it in the singular for one code", async () => {
    withOverview((o) => (o.registration.activeInvites = 1));
    render(<AdminOverview />);
    expect(await text("Registration")).toContain("1 code can still be used");
  });

  it("says anyone can register on an open server, and says nothing about codes", async () => {
    withOverview((o) => (o.registration.inviteOnly = false));
    render(<AdminOverview />);
    const registration = await text("Registration");
    expect(registration).toContain("Anyone");
    expect(registration).not.toContain("Invite codes");
  });

  it("says nobody can register when registration is off, whatever else is set", async () => {
    withOverview((o) => {
      o.registration.enabled = false;
      o.registration.inviteOnly = true;
    });
    render(<AdminOverview />);
    const registration = await text("Registration");
    expect(registration).toContain("Nobody: registration is off");
    expect(registration).not.toContain("Invite codes");
  });

  it("says whether federation is on, who it talks to, how many servers it knows and that nothing is waiting", async () => {
    render(<AdminOverview />);
    const other = await text("Other servers");
    expect(other).toContain("FederationOn");
    expect(other).toContain("Talks toAny server");
    expect(other).toContain("Servers it knows4");
    expect(other).toContain("Waiting to be sentNothing");
    expect(other).toContain("Gave up on0");
  });

  it("says a private server is private, and says nothing about who it talks to", async () => {
    withOverview((o) => (o.federation.enabled = false));
    render(<AdminOverview />);
    const other = await text("Other servers");
    expect(other).toContain("Off: this server is private");
    expect(other).not.toContain("Talks to");
  });

  it("says how many servers an allow list or a block list names, but not which", async () => {
    withOverview((o) => (o.federation.allowedServers = 1));
    const { unmount } = render(<AdminOverview />);
    expect(await text("Other servers")).toContain("Only 1 server on its allow list");
    unmount();
    withOverview((o) => (o.federation.blockedServers = 3));
    render(<AdminOverview />);
    expect(await text("Other servers")).toContain("Every server except 3 blocked ones");
  });

  it("says something is being sent even when nothing else is waiting, and what gave up", async () => {
    withOverview((o) => (o.federation.queue = { pending: 0, retrying: 0, inProgress: 2, failed: 3, oldestPendingAt: null }));
    render(<AdminOverview />);
    const other = await text("Other servers");
    expect(other).not.toContain("Waiting to be sentNothing");
    expect(other).toContain("0 (0 being retried), 2 being sent now");
    expect(other).toContain("Gave up on3");
  });

  it("says what is waiting to be sent, and since when", async () => {
    withOverview((o) => (o.federation.queue = { pending: 5, retrying: 2, inProgress: 1, failed: 0, oldestPendingAt: "2026-06-01T11:30:00.000Z" }));
    render(<AdminOverview />);
    const other = await text("Other servers");
    expect(other).toContain("5 (2 being retried, the oldest from 30 minutes ago), 1 being sent now");
  });

  it("says which features are on, each its own", async () => {
    render(<AdminOverview />);
    const features = await text("Features");
    expect(features).toContain("Voice channelsOn");
    expect(features).toContain("Public directoryOff");
    expect(features).toContain("Link previewsOn");
    expect(features).toContain("1 entry in the last day");
  });

  it("does not mix the features up: with only one of them on, only that one says On", async () => {
    const only = { voice: "Voice channels", directory: "Public directory", linkPreviews: "Link previews" } as const;
    for (const on of Object.keys(only) as (keyof typeof only)[]) {
      withOverview((o) => {
        o.features = { federation: true, voice: on === "voice", directory: on === "directory", linkPreviews: on === "linkPreviews" };
      });
      const { unmount } = render(<AdminOverview />);
      const features = await text("Features");
      for (const [key, label] of Object.entries(only)) expect(features, `${on} on: ${key}`).toContain(`${label}${key === on ? "On" : "Off"}`);
      unmount();
    }
  });

  it("says the audit entries in the plural", async () => {
    withOverview((o) => (o.auditEntriesLastDay = 7));
    render(<AdminOverview />);
    expect(await text("Features")).toContain("7 entries in the last day");
  });

  it("shows the settings in effect in words, each with the name of the variable that sets it", async () => {
    render(<AdminOverview />);
    const settings = await card("Settings in effect");
    expect(settings.textContent).toContain("Waiting period before a deleted account is erased");
    expect(settings.textContent).toContain("14 days");
    expect(settings.textContent).toContain("for ever");
    expect(settings.textContent).toContain("8 MB");
    expect(within(settings).getByText("ACCOUNT_DELETION_GRACE_DAYS").tagName).toBe("CODE");
    expect(settings.textContent).toContain("restart");
  });

  it("shows a setting it has no label for under the name it came with, so nothing is hidden", async () => {
    withOverview((o) => o.settings.push({ setting: "A_NEW_SETTING", value: "x" }));
    render(<AdminOverview />);
    const settings = await card("Settings in effect");
    expect(settings.textContent).toContain("A_NEW_SETTING");
  });
});

describe("what is worth a look", () => {
  it("is not shown when all is well", async () => {
    render(<AdminOverview />);
    await card("Server");
    expect(screen.queryByRole("region", { name: "Worth a look" })).toBeNull();
  });

  it("shows events that gave up", async () => {
    withOverview((o) => (o.federation.queue.failed = 2));
    render(<AdminOverview />);
    const look = await card("Worth a look");
    expect(look.textContent).toContain("2 messages for other servers gave up");
  });

  it("shows something that has been waiting for an hour", async () => {
    withOverview((o) => (o.federation.queue = { pending: 1, retrying: 1, inProgress: 0, failed: 0, oldestPendingAt: "2026-06-01T09:00:00.000Z" }));
    render(<AdminOverview />);
    expect((await card("Worth a look")).textContent).toContain("3 hours ago");
  });
});

describe("loading and refreshing", () => {
  it("says it is loading, and when it was made", async () => {
    render(<AdminOverview />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    // When it was made (the server's moment), not when it is looked at.
    expect((await screen.findByRole("status")).textContent).toBe(`As of ${new Date("2026-06-01T12:00:00.000Z").toLocaleTimeString()}`);
  });

  it("asks again when told to, and shows the new answer", async () => {
    render(<AdminOverview />);
    await card("Server");
    withOverview((o) => (o.people.total = 99));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mocks.getAdminOverview).toHaveBeenCalledTimes(2));
    await waitFor(async () => expect(await text("People")).toContain("Accounts99"));
  });

  it("keeps what it showed when a refresh fails, and says so", async () => {
    render(<AdminOverview />);
    await card("Server");
    mocks.getAdminOverview.mockRejectedValueOnce(new Error("down"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Couldn't load the overview. Try again.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Server" })).toBeTruthy();
  });

  it("says when it could not load at all, and tries again when asked", async () => {
    mocks.getAdminOverview.mockRejectedValueOnce(new Error("down"));
    render(<AdminOverview />);
    expect(await screen.findByText("Couldn't load the overview. Try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await card("Server")).toBeTruthy();
    expect(screen.queryByText("Couldn't load the overview. Try again.")).toBeNull();
  });

  it("does not ask a second question while one is on its way: Refresh cannot be pressed until it is answered", async () => {
    render(<AdminOverview />);
    await card("Server");
    let answer!: (value: { overview: Overview }) => void;
    mocks.getAdminOverview.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const refresh = screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    fireEvent.click(refresh);
    await waitFor(() => expect(mocks.getAdminOverview).toHaveBeenCalledTimes(2));
    expect(refresh.disabled).toBe(true);
    fireEvent.click(refresh);
    expect(mocks.getAdminOverview).toHaveBeenCalledTimes(2);
    answer({ overview: base() });
    await waitFor(() => expect(refresh.disabled).toBe(false));
  });

  it("shows what a server is called as text, never as markup", async () => {
    withOverview((o) => (o.server.name = "<img src=x onerror=alert(1)>"));
    render(<AdminOverview />);
    expect(await text("Server")).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
  });
});
