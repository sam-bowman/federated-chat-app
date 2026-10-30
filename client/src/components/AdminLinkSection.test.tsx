import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import AdminLinkSection from "./AdminLinkSection";

const state = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("../api", () => ({ getOpenReportCount: vi.fn() }));

beforeEach(() => vi.mocked(api.getOpenReportCount).mockReset().mockResolvedValue({ open: 0 }));
afterEach(cleanup);

const show = () =>
  render(
    <MemoryRouter>
      <AdminLinkSection />
    </MemoryRouter>
  );

describe("Settings -> Server administration", () => {
  it("offers the way in to an admin", () => {
    state.user = { id: "me", isAdmin: true };
    show();
    expect(screen.getByRole("link", { name: "Open the admin page" }).getAttribute("href")).toBe("/admin");
  });

  it("says how many reports are waiting for the admins, when there are some", async () => {
    vi.mocked(api.getOpenReportCount).mockResolvedValue({ open: 2 });
    state.user = { id: "me", isAdmin: true };
    show();
    expect((await screen.findByText(/2 reports waiting/)).textContent).toContain("Open the admin page");
    expect(api.getOpenReportCount).toHaveBeenCalledWith(null);
  });

  it("says nothing of reports when none are waiting", async () => {
    vi.mocked(api.getOpenReportCount).mockResolvedValue({ open: 0 });
    state.user = { id: "me", isAdmin: true };
    const { container } = show();
    await waitFor(() => expect(api.getOpenReportCount).toHaveBeenCalled());
    expect(container.textContent).not.toMatch(/waiting/);
  });

  it("says nothing to anyone else: not that there is such a page, not that they are not one", () => {
    for (const user of [{ id: "me", isAdmin: false }, { id: "me" }, null]) {
      state.user = user;
      const { container } = show();
      expect(container.firstChild).toBeNull();
      cleanup();
    }
    expect(api.getOpenReportCount).not.toHaveBeenCalled(); // and asks the server nothing
  });
});
