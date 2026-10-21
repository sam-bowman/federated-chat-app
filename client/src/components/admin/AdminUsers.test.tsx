import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "../../api";
import AdminUsers, { userFlags } from "./AdminUsers";

const mocks = vi.hoisted(() => ({ listAdminUsers: vi.fn() }));
vi.mock("../../api", () => ({ listAdminUsers: mocks.listAdminUsers }));
// The detail panel has its own tests: here it is a stand-in that shows which account was chosen.
vi.mock("./AdminUserDetailPanel", () => ({ default: ({ username }: { username: string }) => <div data-testid="detail">detail of {username}</div> }));

const user = (name: string, over: Partial<AdminUser> = {}): AdminUser => ({
  id: `id-${name}`,
  username: name,
  identity: `@${name}:chat.example`,
  displayName: name[0].toUpperCase() + name.slice(1),
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
  twoFactor: true,
  suspended: false,
  admin: false,
  deletionPending: false,
  communitiesOwned: 0,
  communitiesJoined: 0,
  ...over,
});

beforeEach(() => mocks.listAdminUsers.mockReset().mockResolvedValue({ users: [user("alice"), user("bob")], total: 2 }));
afterEach(cleanup);

describe("userFlags", () => {
  it("says what matters in words, and nothing for an ordinary account with 2FA", () => {
    expect(userFlags(user("a"))).toEqual([]);
    expect(userFlags(user("a", { admin: true, suspended: true, deletionPending: true, twoFactor: false }))).toEqual(["Admin", "Suspended", "Being deleted", "No 2FA"]);
  });
});

describe("the accounts list", () => {
  it("lists the first page with names, identities and flags", async () => {
    mocks.listAdminUsers.mockResolvedValue({ users: [user("alice", { admin: true }), user("bob", { suspended: true, twoFactor: false })], total: 2 });
    render(<AdminUsers />);
    const rows = await screen.findAllByRole("button", { name: /@/ });
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Alice");
    expect(rows[0].textContent).toContain("@alice:chat.example");
    expect(rows[0].textContent).toContain("Admin");
    expect(rows[1].textContent).toContain("Suspended · No 2FA");
    expect(mocks.listAdminUsers).toHaveBeenCalledWith({ search: "", suspended: false, admin: undefined, offset: 0, limit: 25 });
    expect(screen.getByRole("status").textContent).toBe("2 accounts");
  });

  it("searches when asked to, taking what was typed with the spaces off, from the first page", async () => {
    render(<AdminUsers />);
    await screen.findAllByRole("button", { name: /@/ });
    fireEvent.change(screen.getByLabelText("Find an account"), { target: { value: "  rob " } });
    expect(mocks.listAdminUsers).toHaveBeenCalledTimes(1); // typing alone asks nothing
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(mocks.listAdminUsers).toHaveBeenLastCalledWith({ search: "rob", suspended: false, admin: undefined, offset: 0, limit: 25 }));
  });

  it("asks again when Search is pressed again with the same words, and does not wait for an answer that is not coming", async () => {
    mocks.listAdminUsers.mockResolvedValue({ users: [], total: 0 });
    render(<AdminUsers />);
    expect(await screen.findByText("No accounts match.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Find an account"), { target: { value: "ghost" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(mocks.listAdminUsers).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No accounts match.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Search" })); // the same again
    await waitFor(() => expect(mocks.listAdminUsers).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("No accounts match.")).toBeTruthy();
  });

  it("filters to the suspended and to admins", async () => {
    render(<AdminUsers />);
    await screen.findAllByRole("button", { name: /@/ });
    fireEvent.click(screen.getByLabelText("Suspended only"));
    await waitFor(() => expect(mocks.listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ suspended: true })));
    fireEvent.click(screen.getByLabelText("Admins only"));
    await waitFor(() => expect(mocks.listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ suspended: true, admin: true })));
    fireEvent.click(screen.getByLabelText("Suspended only"));
    await waitFor(() => expect(mocks.listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ suspended: false, admin: true })));
  });

  it("pages through a long list, and goes back to the first page when the search changes", async () => {
    const many = Array.from({ length: 25 }, (_, i) => user(`user${i}`));
    mocks.listAdminUsers.mockResolvedValue({ users: many, total: 60 });
    render(<AdminUsers />);
    await screen.findAllByRole("button", { name: /@/ });
    expect(screen.getByRole("status").textContent).toBe("1–25 of 60");
    const previous = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mocks.listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 })));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("26–50 of 60"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("51–60 of 60"));
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Find an account"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(mocks.listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ search: "x", offset: 0 })));
  });

  it("shows the account chosen, and which one", async () => {
    render(<AdminUsers />);
    expect(screen.getByText("Choose an account to see it and what you can do to it.")).toBeTruthy();
    fireEvent.click((await screen.findAllByRole("button", { name: /@bob/ }))[0]);
    expect((await screen.findByTestId("detail")).textContent).toBe("detail of bob");
    expect(screen.getByRole("button", { name: /@bob/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /@alice/ }).getAttribute("aria-current")).toBeNull();
  });

  it("says when nothing matches, and when it could not load", async () => {
    mocks.listAdminUsers.mockResolvedValueOnce({ users: [], total: 0 });
    const { unmount } = render(<AdminUsers />);
    expect(await screen.findByText("No accounts match.")).toBeTruthy();
    unmount();

    mocks.listAdminUsers.mockRejectedValueOnce(new Error("down"));
    render(<AdminUsers />);
    expect(await screen.findByText("Couldn't load the accounts. Try again.")).toBeTruthy();
  });

  it("lets only the latest question answer", async () => {
    let answerFirst!: (page: { users: AdminUser[]; total: number }) => void;
    mocks.listAdminUsers.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve))).mockResolvedValue({ users: [user("newer")], total: 1 });
    render(<AdminUsers />);
    fireEvent.click(screen.getByLabelText("Admins only"));
    await screen.findByText("Newer");
    answerFirst({ users: [user("older")], total: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Older")).toBeNull();
    expect(screen.getByText("Newer")).toBeTruthy();
  });

  it("shows what a person typed as text, never as markup", async () => {
    mocks.listAdminUsers.mockResolvedValue({ users: [user("evil", { displayName: "<img src=x onerror=alert(1)>" })], total: 1 });
    render(<AdminUsers />);
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});
