import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import AdminPage from "./AdminPage";

const mocks = vi.hoisted(() => ({ getAdminMe: vi.fn(), getAdminAuditLog: vi.fn(), listAdminUsers: vi.fn(), listAdminRegistrationInvites: vi.fn(), listAdminCommunities: vi.fn(), getAdminOverview: vi.fn(), listReports: vi.fn() }));
vi.mock("../api", () => ({
  getAdminMe: mocks.getAdminMe,
  getAdminAuditLog: mocks.getAdminAuditLog,
  listAdminUsers: mocks.listAdminUsers,
  listAdminRegistrationInvites: mocks.listAdminRegistrationInvites,
  listAdminCommunities: mocks.listAdminCommunities,
  getAdminOverview: mocks.getAdminOverview,
  listReports: mocks.listReports,
}));

beforeEach(() => {
  mocks.getAdminMe.mockReset();
  mocks.getAdminAuditLog.mockReset().mockResolvedValue({ entries: [], next: null });
  mocks.listAdminUsers.mockReset().mockResolvedValue({ users: [], total: 0 });
  mocks.getAdminOverview.mockReset().mockResolvedValue({
    overview: {
      generatedAt: "2026-06-01T12:00:00.000Z",
      server: { name: "S", domain: "s.example", version: "1.0.0", storage: "disk", redis: false },
      registration: { enabled: true, inviteOnly: false, activeInvites: 0 },
      features: { federation: true, voice: false, directory: false, linkPreviews: false },
      federation: { enabled: true, allowedServers: 0, blockedServers: 0, knownServers: 0, queue: { pending: 0, retrying: 0, inProgress: 0, failed: 0, oldestPendingAt: null } },
      people: { total: 1, activeLastDay: 1, activeLastWeek: 1, activeLastMonth: 1, joinedLastWeek: 0, suspended: 0, deletionPending: 0, admins: 1, withoutTwoFactor: 0 },
      communities: { hosted: 0, copiesOfOthers: 0, memberships: 0, textChannels: 0, voiceChannels: 0, byVisibility: { UNLISTED: 0, PUBLIC: 0, INVITE_ONLY: 0, LOCAL_ONLY: 0 } },
      auditEntriesLastDay: 0,
      settings: [],
    },
  });
  mocks.listReports.mockReset().mockResolvedValue({ reports: [], next: null, open: 0 });
  mocks.listAdminCommunities.mockReset().mockResolvedValue({ communities: [], total: 0 });
  mocks.listAdminRegistrationInvites.mockReset().mockResolvedValue({ invites: [], total: 0, registration: { enabled: true, inviteOnly: true } });
});
afterEach(cleanup);

const show = () =>
  render(
    <MemoryRouter>
      <AdminPage />
    </MemoryRouter>
  );

describe("the admin page", () => {
  it("is the same 'not found' as any address that is not a page, for someone who is not an admin, and loads nothing", async () => {
    mocks.getAdminMe.mockRejectedValue(new ApiError(404, { error: "not_found" }));
    show();
    expect(await screen.findByText("Page not found.")).toBeTruthy();
    expect(screen.queryByText("Server administration")).toBeNull();
    expect(mocks.getAdminAuditLog).not.toHaveBeenCalled();
    expect(mocks.listAdminUsers).not.toHaveBeenCalled();
  });

  it("tells an admin without two-factor sign-in what to do, and loads nothing", async () => {
    mocks.getAdminMe.mockResolvedValue({ admin: true, twoFactor: false });
    show();
    expect(await screen.findByText("Turn on two-factor sign-in first")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
    expect(mocks.getAdminAuditLog).not.toHaveBeenCalled();
  });

  it("opens on the overview for an admin with two-factor sign-in, and the users, the communities, the invites and the audit log are a tab away", async () => {
    mocks.getAdminMe.mockResolvedValue({ admin: true, twoFactor: true });
    show();
    expect(await screen.findByRole("tab", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(mocks.getAdminOverview).toHaveBeenCalled());
    expect(await screen.findByRole("region", { name: "Server" })).toBeTruthy();
    // Nothing else is asked for until its tab is opened.
    expect(mocks.listAdminUsers).not.toHaveBeenCalled();
    expect(mocks.getAdminAuditLog).not.toHaveBeenCalled();
    expect(mocks.listAdminRegistrationInvites).not.toHaveBeenCalled();
    expect(mocks.listAdminCommunities).not.toHaveBeenCalled();
    expect(screen.getByText("Server administration")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    await waitFor(() => expect(mocks.listAdminUsers).toHaveBeenCalled());
    expect(await screen.findByLabelText("Find an account")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Communities" }));
    await waitFor(() => expect(mocks.listAdminCommunities).toHaveBeenCalledWith({ search: "", offset: 0, limit: 25 }));
    expect(await screen.findByLabelText("Find a community")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Invites" }));
    await waitFor(() => expect(mocks.listAdminRegistrationInvites).toHaveBeenCalledWith(false));
    expect(await screen.findByRole("button", { name: "Make invites…" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Reports" }));
    await waitFor(() => expect(mocks.listReports).toHaveBeenCalledWith(null, { before: undefined, limit: 25, status: "open" }));
    expect(await screen.findByText("Nothing to look at. No reports are waiting.")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Audit log" }));
    await waitFor(() => expect(mocks.getAdminAuditLog).toHaveBeenCalledWith({ before: undefined, limit: 50 }));
  });

  it("says so when the server cannot be reached, which is not the same as not found", async () => {
    mocks.getAdminMe.mockRejectedValue(new ApiError(500, null));
    show();
    expect(await screen.findByText(/Couldn't reach the server/)).toBeTruthy();
    expect(screen.queryByText("Page not found.")).toBeNull();
  });

  it("shows nothing but a loading line while it asks", () => {
    mocks.getAdminMe.mockReturnValue(new Promise(() => {}));
    show();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("Page not found.")).toBeNull();
  });
});
