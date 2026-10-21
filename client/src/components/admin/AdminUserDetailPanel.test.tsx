import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUserDetail } from "../../api";
import { ApiError } from "../../api/client";
import AdminUserDetailPanel from "./AdminUserDetailPanel";
import { SudoProvider } from "./SudoContext";

const mocks = vi.hoisted(() => ({
  getAdminUser: vi.fn(),
  adminSudo: vi.fn(),
  adminSuspend: vi.fn(),
  adminUnsuspend: vi.fn(),
  adminResetPassword: vi.fn(),
  adminDisableTwoFactor: vi.fn(),
  adminCancelDeletion: vi.fn(),
  adminDeleteUser: vi.fn(),
  adminSetAdmin: vi.fn(),
}));
vi.mock("../../api", () => mocks);

const detail = (over: Partial<AdminUserDetail> = {}): AdminUserDetail => ({
  id: "id-bob",
  username: "bob",
  identity: "@bob:chat.example",
  displayName: "Bob",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
  twoFactor: true,
  suspended: false,
  admin: false,
  deletionPending: false,
  communitiesOwned: 0,
  communitiesJoined: 2,
  suspendedAt: null,
  deletionRequestedAt: null,
  deletionScheduledFor: null,
  activeSessions: 3,
  ownedCommunities: [],
  registrationInviteNote: null,
  ...over,
});

const onChanged = vi.fn();
const onGone = vi.fn();
const show = (user: AdminUserDetail = detail()) => {
  mocks.getAdminUser.mockResolvedValue({ user });
  return render(
    <SudoProvider>
      <AdminUserDetailPanel username={user.username} onChanged={onChanged} onGone={onGone} />
    </SudoProvider>
  );
};
const button = (name: string) => screen.findByRole("button", { name });
/** Confirms sudo mode in its dialog. */
async function confirmSudo() {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
  fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "pw" } });
  fireEvent.change(within(dialog).getByLabelText(/Code from your authenticator app/), { target: { value: "123456" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm it is you" })).toBeNull());
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  onChanged.mockReset();
  onGone.mockReset();
  mocks.adminSudo.mockResolvedValue({ sudoToken: "sudo-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
});
afterEach(cleanup);

describe("an account", () => {
  it("shows what an admin needs to decide, in words", async () => {
    show(detail({ ownedCommunities: [{ id: "c1", name: "Book Club" }], communitiesOwned: 1, registrationInviteNote: "for Bob's sister" }));
    expect(await screen.findByRole("heading", { name: "Bob" })).toBeTruthy();
    const facts = screen.getByRole("region", { name: "Account @bob:chat.example" }).textContent!;
    expect(facts).toContain("Two-factor sign-inOn");
    expect(facts).toContain("AdminNo");
    expect(facts).toContain("AccountActive");
    expect(facts).toContain("3 that can be refreshed");
    expect(facts).toContain("Owns 1 (Book Club), in 2");
    expect(facts).toContain("for Bob's sister");
  });

  it("says when it is suspended and when it is going to be erased", async () => {
    show(detail({ suspended: true, suspendedAt: "2026-02-01T00:00:00.000Z", deletionPending: true, deletionRequestedAt: "2026-03-01T00:00:00.000Z", deletionScheduledFor: "2026-03-15T00:00:00.000Z" }));
    expect(await screen.findByText(/Suspended since/)).toBeTruthy();
    expect(screen.getByText(/unless they sign in first/)).toBeTruthy();
  });

  it("says when it cannot be loaded", async () => {
    mocks.getAdminUser.mockRejectedValue(new ApiError(404, { error: "not_found" }));
    render(
      <SudoProvider>
        <AdminUserDetailPanel username="ghost" onChanged={onChanged} onGone={onGone} />
      </SudoProvider>
    );
    expect(await screen.findByText(/does not exist, or is not on this server/)).toBeTruthy();
  });

  it("shows markup in a name as the text it is", async () => {
    show(detail({ displayName: "<img src=x onerror=alert(1)>" }));
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("which actions are offered", () => {
  it("an ordinary account: suspend, new password, turn off 2FA, delete and make admin", async () => {
    show();
    for (const name of ["Suspend…", "Set a new password…", "Turn off two-factor…", "Delete…", "Make admin…"]) expect(await button(name)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unsuspend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel the deletion" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove admin" })).toBeNull();
  });

  it("does not offer to turn off 2FA when it is not on", async () => {
    show(detail({ twoFactor: false }));
    await button("Suspend…");
    expect(screen.queryByRole("button", { name: "Turn off two-factor…" })).toBeNull();
  });

  it("a suspended account: unsuspend, and no way to make it an admin", async () => {
    show(detail({ suspended: true, suspendedAt: "2026-02-01T00:00:00.000Z" }));
    expect(await button("Unsuspend")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Suspend…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make admin…" })).toBeNull();
  });

  it("an account whose deletion is pending: take it back, or erase it now", async () => {
    show(detail({ deletionPending: true, deletionRequestedAt: "2026-03-01T00:00:00.000Z", deletionScheduledFor: "2026-03-15T00:00:00.000Z" }));
    expect(await button("Cancel the deletion")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Erase now…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
  });

  it("an admin: only taking admin away, with the reason; nothing else is offered", async () => {
    show(detail({ admin: true }));
    expect(await button("Remove admin")).toBeTruthy();
    expect(screen.getByText(/can only be changed here by taking admin away/)).toBeTruthy();
    for (const name of ["Suspend…", "Set a new password…", "Turn off two-factor…", "Delete…", "Make admin…", "Unsuspend"]) {
      expect(screen.queryByRole("button", { name }), name).toBeNull();
    }
  });
});

describe("doing something", () => {
  it("asks to confirm it is them first, then does it with the sudo token, and shows the account as it is now", async () => {
    mocks.adminUnsuspend.mockResolvedValue({ user: detail({ suspended: false }) });
    show(detail({ suspended: true, suspendedAt: "2026-02-01T00:00:00.000Z" }));
    fireEvent.click(await button("Unsuspend"));
    await confirmSudo();

    await waitFor(() => expect(mocks.adminUnsuspend).toHaveBeenCalledWith("bob", "sudo-1"));
    expect(await button("Suspend…")).toBeTruthy();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("asks nothing more for the next one while the confirmation lasts", async () => {
    mocks.adminUnsuspend.mockResolvedValue({ user: detail() });
    mocks.adminSuspend.mockResolvedValue({ user: detail({ suspended: true, suspendedAt: "2026-02-01T00:00:00.000Z" }) });
    show(detail({ suspended: true, suspendedAt: "2026-02-01T00:00:00.000Z" }));
    fireEvent.click(await button("Unsuspend"));
    await confirmSudo();
    fireEvent.click(await button("Suspend…"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: /Suspend/ })).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(mocks.adminSuspend).toHaveBeenCalledWith("bob", "sudo-1"));
    expect(mocks.adminSudo).toHaveBeenCalledOnce();
  });

  it("does nothing, and shows no error, when they back out of confirming", async () => {
    show(detail({ suspended: true, suspendedAt: "2026-02-01T00:00:00.000Z" }));
    fireEvent.click(await button("Unsuspend"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.adminUnsuspend).not.toHaveBeenCalled();
    expect(document.querySelector(".error-text")).toBeNull();
    expect(await button("Unsuspend")).toBeTruthy();
  });

  it("suspending asks 'are you sure' first, and does nothing if the answer is no", async () => {
    show();
    fireEvent.click(await button("Suspend…"));
    const dialog = await screen.findByRole("dialog", { name: "Suspend @bob:chat.example?" });
    expect(dialog.textContent).toContain("signed out everywhere");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.adminSudo).not.toHaveBeenCalled();
    expect(mocks.adminSuspend).not.toHaveBeenCalled();
  });

  it("explains a refusal in words and leaves the account as it was", async () => {
    mocks.adminSuspend.mockRejectedValue(new ApiError(409, { error: "target_is_admin" }));
    show();
    fireEvent.click(await button("Suspend…"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: /Suspend/ })).getByRole("button", { name: "Suspend" }));
    await confirmSudo();
    expect(await screen.findByText(/This account is an admin/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Suspend…" })).toBeTruthy();
  });

  it.each([
    ["Turn off two-factor…", "Turn off", "adminDisableTwoFactor"],
    ["Make admin…", "Make admin", "adminSetAdmin"],
  ] as const)("%s asks to confirm, then does it", async (open, confirm, fn) => {
    mocks[fn].mockResolvedValue({ user: detail() });
    show();
    fireEvent.click(await button(open));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: confirm }));
    await confirmSudo();
    await waitFor(() => expect(mocks[fn]).toHaveBeenCalled());
    if (fn === "adminSetAdmin") expect(mocks.adminSetAdmin).toHaveBeenCalledWith("bob", true, "sudo-1");
    else expect(mocks.adminDisableTwoFactor).toHaveBeenCalledWith("bob", "sudo-1");
  });

  it("taking admin away asks first and sends false", async () => {
    mocks.adminSetAdmin.mockResolvedValue({ user: detail({ admin: false }) });
    show(detail({ admin: true }));
    fireEvent.click(await button("Remove admin"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove admin" }));
    await confirmSudo();
    await waitFor(() => expect(mocks.adminSetAdmin).toHaveBeenCalledWith("bob", false, "sudo-1"));
    expect(await button("Suspend…")).toBeTruthy(); // no longer an admin: now it can be managed
  });

  it("cancelling a deletion does not ask first", async () => {
    mocks.adminCancelDeletion.mockResolvedValue({ user: detail() });
    show(detail({ deletionPending: true, deletionRequestedAt: "2026-03-01T00:00:00.000Z", deletionScheduledFor: "2026-03-15T00:00:00.000Z" }));
    fireEvent.click(await button("Cancel the deletion"));
    await confirmSudo();
    await waitFor(() => expect(mocks.adminCancelDeletion).toHaveBeenCalledWith("bob", "sudo-1"));
  });
});

describe("a new password", () => {
  it("needs the same thing twice, then sets it", async () => {
    mocks.adminResetPassword.mockResolvedValue({ user: detail() });
    show();
    fireEvent.click(await button("Set a new password…"));
    const dialog = await screen.findByRole("dialog", { name: "New password for @bob:chat.example" });
    const set = within(dialog).getByRole("button", { name: "Set the password" }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("New password"), { target: { value: "Brand-New-Passw0rd!" } });
    fireEvent.change(within(dialog).getByLabelText("Again"), { target: { value: "Different-Passw0rd!" } });
    expect(within(dialog).getByText("The two are not the same.")).toBeTruthy();
    expect(set.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Again"), { target: { value: "Brand-New-Passw0rd!" } });
    expect(set.disabled).toBe(false);
    fireEvent.click(set);
    await confirmSudo();
    await waitFor(() => expect(mocks.adminResetPassword).toHaveBeenCalledWith("bob", "Brand-New-Passw0rd!", "sudo-1"));
  });

  it("says the password was not accepted, in words, when it breaks the sign-up rules", async () => {
    mocks.adminResetPassword.mockRejectedValue(new ApiError(400, { error: "invalid_request" }));
    show();
    fireEvent.click(await button("Set a new password…"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("New password"), { target: { value: "weak" } });
    fireEvent.change(within(dialog).getByLabelText("Again"), { target: { value: "weak" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set the password" }));
    await confirmSudo();
    expect(await screen.findByText(/sign-up rules/)).toBeTruthy();
  });
});

describe("deleting", () => {
  it("asks for it after the waiting period by default, with nothing to type", async () => {
    mocks.adminDeleteUser.mockResolvedValue({ user: detail({ deletionPending: true, deletionRequestedAt: "2026-03-01T00:00:00.000Z", deletionScheduledFor: "2026-03-15T00:00:00.000Z" }) });
    show();
    fireEvent.click(await button("Delete…"));
    const dialog = await screen.findByRole("dialog", { name: "Delete @bob:chat.example" });
    expect(within(dialog).queryByLabelText(/Type their username/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await confirmSudo();
    await waitFor(() => expect(mocks.adminDeleteUser).toHaveBeenCalledWith("bob", {}, "sudo-1"));
    expect(await button("Cancel the deletion")).toBeTruthy();
  });

  it("will not erase at once until the username is typed out, and then sends it", async () => {
    mocks.adminDeleteUser.mockResolvedValue({ erased: true });
    show();
    fireEvent.click(await button("Delete…"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /Erase now/ }));
    const erase = within(dialog).getByRole("button", { name: "Erase now" }) as HTMLButtonElement;
    expect(erase.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Type their username/), { target: { value: "bobby" } });
    expect(erase.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Type their username/), { target: { value: " BOB " } });
    expect(erase.disabled).toBe(false);
    fireEvent.click(erase);
    await confirmSudo();
    await waitFor(() => expect(mocks.adminDeleteUser).toHaveBeenCalledWith("bob", { now: true, confirm: " BOB " }, "sudo-1"));
    await waitFor(() => expect(onGone).toHaveBeenCalledOnce());
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("for an account already waiting, offers only erasing now", async () => {
    show(detail({ deletionPending: true, deletionRequestedAt: "2026-03-01T00:00:00.000Z", deletionScheduledFor: "2026-03-15T00:00:00.000Z" }));
    fireEvent.click(await button("Erase now…"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("radio", { name: /Delete after the waiting period/ })).toBeNull();
    expect(within(dialog).getByLabelText(/Type their username/)).toBeTruthy();
  });

  it("says which community is in the way", async () => {
    mocks.adminDeleteUser.mockRejectedValue(new ApiError(409, { error: "owns_communities", communities: [{ id: "c1", name: "Book Club" }] }));
    show(detail({ communitiesOwned: 1, ownedCommunities: [{ id: "c1", name: "Book Club" }] }));
    fireEvent.click(await button("Delete…"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/They own a community/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await confirmSudo();
    expect(await screen.findByText(/Book Club/, { selector: ".error-text" })).toBeTruthy();
  });
});
