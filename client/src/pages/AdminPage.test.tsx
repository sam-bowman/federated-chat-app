import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import AdminPage from "./AdminPage";

const mocks = vi.hoisted(() => ({ getAdminMe: vi.fn(), getAdminAuditLog: vi.fn(), listAdminUsers: vi.fn() }));
vi.mock("../api", () => ({ getAdminMe: mocks.getAdminMe, getAdminAuditLog: mocks.getAdminAuditLog, listAdminUsers: mocks.listAdminUsers }));

beforeEach(() => {
  mocks.getAdminMe.mockReset();
  mocks.getAdminAuditLog.mockReset().mockResolvedValue({ entries: [], next: null });
  mocks.listAdminUsers.mockReset().mockResolvedValue({ users: [], total: 0 });
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

  it("opens on the accounts for an admin with two-factor sign-in, and the audit log is a tab away", async () => {
    mocks.getAdminMe.mockResolvedValue({ admin: true, twoFactor: true });
    show();
    expect(await screen.findByRole("tab", { name: "Users" })).toBeTruthy();
    await waitFor(() => expect(mocks.listAdminUsers).toHaveBeenCalled());
    expect(mocks.getAdminAuditLog).not.toHaveBeenCalled();
    expect(screen.getByText("Server administration")).toBeTruthy();

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
