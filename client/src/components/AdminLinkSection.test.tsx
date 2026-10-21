import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminLinkSection from "./AdminLinkSection";

const state = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: state.user }) }));

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

  it("says nothing to anyone else: not that there is such a page, not that they are not one", () => {
    for (const user of [{ id: "me", isAdmin: false }, { id: "me" }, null]) {
      state.user = user;
      const { container } = show();
      expect(container.firstChild).toBeNull();
      cleanup();
    }
  });
});
