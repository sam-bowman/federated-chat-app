import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminCommunityDetail } from "../../api";
import { ApiError } from "../../api/client";
import AdminCommunityDetailPanel from "./AdminCommunityDetailPanel";
import { SudoProvider } from "./SudoContext";

const mocks = vi.hoisted(() => ({
  getAdminCommunity: vi.fn(),
  adminTransferCommunity: vi.fn(),
  adminDeleteCommunity: vi.fn(),
  adminSudo: vi.fn(),
}));
vi.mock("../../api", () => mocks);

const detail = (over: Partial<AdminCommunityDetail> = {}): AdminCommunityDetail => ({
  id: "c1",
  name: "Book Club",
  owner: "@alice:chat.example",
  members: 5,
  channels: 3,
  visibility: "UNLISTED",
  createdAt: "2026-01-01T00:00:00.000Z",
  localMembers: 3,
  remoteMembers: 2,
  remoteDomains: ["far.example", "other.example"],
  textChannels: 2,
  voiceChannels: 1,
  ...over,
});

const onChanged = vi.fn();
const onGone = vi.fn();
const show = (community: AdminCommunityDetail = detail()) => {
  mocks.getAdminCommunity.mockResolvedValue({ community });
  return render(
    <SudoProvider>
      <AdminCommunityDetailPanel id={community.id} onChanged={onChanged} onGone={onGone} />
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

describe("a community", () => {
  it("shows how big it is and where its people are from, in words", async () => {
    show();
    expect(await screen.findByRole("heading", { name: "Book Club" })).toBeTruthy();
    const facts = screen.getByRole("region", { name: "Community Book Club" }).textContent!;
    expect(facts).toContain("@alice:chat.example");
    expect(facts).toContain("5: 3 on this server, 2 on other servers (far.example, other.example)");
    expect(facts).toContain("2 text, 1 voice");
    expect(facts).toContain("Anyone with the community code");
    expect(mocks.getAdminCommunity).toHaveBeenCalledWith("c1");
  });

  it("says the servers only when there are members on other ones, and names who can join in the words Settings uses", async () => {
    show(detail({ remoteMembers: 0, remoteDomains: [], visibility: "LOCAL_ONLY" }));
    await screen.findByRole("heading", { name: "Book Club" });
    const facts = screen.getByRole("region", { name: "Community Book Club" }).textContent!;
    expect(facts).toContain("0 on other servers");
    expect(facts).not.toContain("(");
    expect(facts).toContain("Only people on this server");
  });

  it("says when it cannot be loaded, in words and never as a code", async () => {
    mocks.getAdminCommunity.mockRejectedValue(new ApiError(404, { error: "not_found" }));
    render(
      <SudoProvider>
        <AdminCommunityDetailPanel id="c1" onChanged={onChanged} onGone={onGone} />
      </SudoProvider>
    );
    expect(await screen.findByText(/does not exist, or is not on this server/)).toBeTruthy();
  });

  it("shows what is typed in its name as text, never as markup", async () => {
    show(detail({ name: "<img src=x onerror=alert(1)>" }));
    expect(await screen.findByRole("heading", { name: "<img src=x onerror=alert(1)>" })).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("handing it to another member", () => {
  it("asks who, then confirms it is them, then hands it over, and shows the community as it is now", async () => {
    show();
    mocks.adminTransferCommunity.mockResolvedValue({ community: detail({ owner: "@carol:chat.example" }) });
    fireEvent.click(await button("Hand to another member…"));
    const dialog = await screen.findByRole("dialog", { name: "Hand Book Club to another member" });
    expect(dialog.textContent).toContain("@alice:chat.example stays a member");
    const submit = within(dialog).getByRole("button", { name: "Hand it over" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // nobody named yet
    fireEvent.change(within(dialog).getByLabelText("Username of the new owner"), { target: { value: "  carol " } });
    fireEvent.click(submit);
    await confirmSudo();
    await waitFor(() => expect(mocks.adminTransferCommunity).toHaveBeenCalledWith("c1", "carol", "sudo-1"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Community Book Club" }).textContent).toContain("@carol:chat.example"));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onGone).not.toHaveBeenCalled();
  });

  it("makes nothing happen, and says nothing, when they back out of confirming it is them", async () => {
    show();
    fireEvent.click(await button("Hand to another member…"));
    const dialog = await screen.findByRole("dialog", { name: /Hand Book Club/ });
    fireEvent.change(within(dialog).getByLabelText("Username of the new owner"), { target: { value: "carol" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Hand it over" }));
    const sudo = await screen.findByRole("dialog", { name: "Confirm it is you" });
    fireEvent.click(within(sudo).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.adminTransferCommunity).not.toHaveBeenCalled();
    expect(document.querySelector(".error-text")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("explains each refusal in words, and changes nothing on the page", async () => {
    show();
    const refusals: [number, string, RegExp][] = [
      [404, "user_not_found", /no one on this server with that username/],
      [404, "not_a_member", /not a member of this community/],
      [400, "already_owner", /already own this community/],
      [409, "target_suspended", /suspended/],
      [409, "ownership_changed", /Someone else changed the owner/],
      [400, "new_owner_must_be_local", /someone on this server/],
      [409, "not_hosted_here", /hosted on another server/],
    ];
    for (const [status, code, words] of refusals) {
      mocks.adminTransferCommunity.mockReset().mockRejectedValue(new ApiError(status, { error: code }));
      fireEvent.click(await button("Hand to another member…"));
      const dialog = await screen.findByRole("dialog", { name: /Hand Book Club/ });
      fireEvent.change(within(dialog).getByLabelText("Username of the new owner"), { target: { value: "carol" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Hand it over" }));
      if (screen.queryByRole("dialog", { name: "Confirm it is you" })) await confirmSudo();
      const message = await screen.findByText(words);
      expect(message.className, code).toContain("error-text");
      expect(message.textContent, code).not.toContain(code);
    }
    expect(screen.getByRole("region", { name: "Community Book Club" }).textContent).toContain("@alice:chat.example");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not ask to confirm it is them, or hand anything over, when no one is named", async () => {
    show();
    fireEvent.click(await button("Hand to another member…"));
    const dialog = await screen.findByRole("dialog", { name: /Hand Book Club/ });
    fireEvent.change(within(dialog).getByLabelText("Username of the new owner"), { target: { value: "   " } });
    fireEvent.submit(dialog.querySelector("form")!);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("dialog", { name: "Confirm it is you" })).toBeNull();
    expect(screen.getByRole("dialog", { name: /Hand Book Club/ })).toBeTruthy();
    expect(mocks.adminTransferCommunity).not.toHaveBeenCalled();
  });

  it("cancels without asking anything", async () => {
    show();
    fireEvent.click(await button("Hand to another member…"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: /Hand Book Club/ })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.adminSudo).not.toHaveBeenCalled();
  });
});

describe("deleting it", () => {
  const open = async () => {
    fireEvent.click(await button("Delete…"));
    return screen.findByRole("dialog", { name: "Delete Book Club" });
  };

  it("needs its name typed out, in any case, and says what it takes with it", async () => {
    show();
    const dialog = await open();
    expect(dialog.textContent).toContain("messages");
    expect(dialog.textContent).toContain("cannot be undone");
    const confirm = within(dialog).getByRole("button", { name: "Delete for good" }) as HTMLButtonElement;
    const field = within(dialog).getByLabelText(/Type its name/);
    expect(confirm.disabled).toBe(true);
    for (const wrong of ["Book", "Book Club!", "Chess"]) {
      fireEvent.change(field, { target: { value: wrong } });
      expect(confirm.disabled, wrong).toBe(true);
    }
    fireEvent.change(field, { target: { value: "  book CLUB " } });
    expect(confirm.disabled).toBe(false);
  });

  it("confirms it is them, deletes it with what was typed, and lets go of it", async () => {
    show();
    mocks.adminDeleteCommunity.mockResolvedValue({ deleted: true });
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText(/Type its name/), { target: { value: "book club" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));
    await confirmSudo();
    await waitFor(() => expect(mocks.adminDeleteCommunity).toHaveBeenCalledWith("c1", "book club", "sudo-1"));
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does nothing when they back out of confirming it is them", async () => {
    show();
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText(/Type its name/), { target: { value: "Book Club" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Confirm it is you" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.adminDeleteCommunity).not.toHaveBeenCalled();
    expect(onGone).not.toHaveBeenCalled();
    expect(document.querySelector(".error-text")).toBeNull();
  });

  it("explains it when the server refuses, and keeps the community on the page", async () => {
    show();
    mocks.adminDeleteCommunity.mockRejectedValue(new ApiError(409, { error: "not_hosted_here" }));
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText(/Type its name/), { target: { value: "Book Club" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));
    await confirmSudo();
    expect(await screen.findByText(/hosted on another server/)).toBeTruthy();
    expect(onGone).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Book Club" })).toBeTruthy();
  });

  it("does not delete when the form is submitted without the name", async () => {
    show();
    const dialog = await open();
    fireEvent.submit(dialog.querySelector("form")!);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("dialog", { name: "Confirm it is you" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Delete Book Club" })).toBeTruthy();
    expect(mocks.adminDeleteCommunity).not.toHaveBeenCalled();
  });
});
