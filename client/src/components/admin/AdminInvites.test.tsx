import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminRegistrationInvite, AdminRegistrationInvites } from "../../api";
import { ApiError } from "../../api/client";
import AdminInvites from "./AdminInvites";
import { SudoProvider } from "./SudoContext";

const mocks = vi.hoisted(() => ({
  listAdminRegistrationInvites: vi.fn(),
  adminCreateRegistrationInvites: vi.fn(),
  adminRevokeRegistrationInvite: vi.fn(),
  adminSudo: vi.fn(),
}));
vi.mock("../../api", () => mocks);

const invite = (code: string, over: Partial<AdminRegistrationInvite> = {}): AdminRegistrationInvite => ({
  id: `id-${code}`,
  code,
  note: null,
  status: "active",
  uses: 0,
  maxUses: 1,
  expiresAt: "2026-12-01T00:00:00.000Z",
  revokedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  joined: [],
  ...over,
});
const answer = (invites: AdminRegistrationInvite[], over: Partial<AdminRegistrationInvites> = {}): AdminRegistrationInvites => ({
  invites,
  total: invites.length,
  registration: { enabled: true, inviteOnly: true },
  ...over,
});

const show = () =>
  render(
    <SudoProvider>
      <AdminInvites />
    </SudoProvider>
  );
const rows = () => within(screen.getByRole("list", { name: "Registration invites" })).getAllByRole("listitem");
/** Confirms sudo mode in its dialog. */
async function confirmSudo() {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
  fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "pw" } });
  fireEvent.change(within(dialog).getByLabelText(/Code from your authenticator app/), { target: { value: "123456" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm it is you" })).toBeNull());
}
const writeText = vi.fn();

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.listAdminRegistrationInvites.mockResolvedValue(answer([invite("AAAAAAAAAA")]));
  mocks.adminSudo.mockResolvedValue({ sudoToken: "sudo-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

describe("the list", () => {
  it("shows each code with its state, use, ending, note and who joined, newest as the server sent them", async () => {
    mocks.listAdminRegistrationInvites.mockResolvedValue(
      answer([
        invite("BBBBBBBBBB", { note: "for Alex", uses: 1, maxUses: 3, joined: ["carol"] }),
        invite("AAAAAAAAAA", { maxUses: null, expiresAt: null }),
      ])
    );
    show();
    await screen.findByText("BBBBBBBBBB");
    const [first, second] = rows();
    expect(first.textContent).toContain("BBBBBBBBBB");
    expect(first.textContent).toContain("Active");
    expect(first.textContent).toContain("1 of 3 used");
    expect(first.textContent).toContain("Note: for Alex");
    expect(first.textContent).toContain("Joined: carol");
    expect(second.textContent).toContain("0 used · never ends");
    expect(mocks.listAdminRegistrationInvites).toHaveBeenCalledWith(false);
    expect(screen.getByRole("status").textContent).toBe("2 invites");
  });

  it("offers to copy, link and revoke only for a code that can still be used", async () => {
    mocks.listAdminRegistrationInvites.mockResolvedValue(
      answer([invite("AAAAAAAAAA"), invite("RRRRRRRRRR", { status: "revoked" }), invite("EEEEEEEEEE", { status: "expired" }), invite("UUUUUUUUUU", { status: "used_up", uses: 1 })])
    );
    show();
    await screen.findByText("AAAAAAAAAA");
    const [active, revoked, expired, usedUp] = rows();
    for (const name of ["Copy code", "Copy link", "Revoke…"]) expect(within(active).getByRole("button", { name })).toBeTruthy();
    for (const row of [revoked, expired, usedUp]) expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(revoked.textContent).toContain("Revoked");
    expect(expired.textContent).toContain("Expired");
    expect(expired.textContent).toContain("ended");
    expect(usedUp.textContent).toContain("Used up");
  });

  it("asks for every code when told to show the ones that are over, and says when there are none", async () => {
    mocks.listAdminRegistrationInvites.mockResolvedValue(answer([]));
    show();
    expect(await screen.findByText("There are no invites that can still be used.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show revoked, expired and used up"));
    await waitFor(() => expect(mocks.listAdminRegistrationInvites).toHaveBeenLastCalledWith(true));
    expect(await screen.findByText("There are no registration invites.")).toBeTruthy();
  });

  it("says when it is only showing the newest of many", async () => {
    mocks.listAdminRegistrationInvites.mockResolvedValue(answer([invite("AAAAAAAAAA")], { total: 450 }));
    show();
    await screen.findByText("AAAAAAAAAA");
    expect(screen.getByRole("status").textContent).toBe("Showing the newest 1 of 450.");
  });

  it("says when it could not load", async () => {
    mocks.listAdminRegistrationInvites.mockRejectedValue(new Error("down"));
    show();
    expect(await screen.findByText("Couldn't load the invites. Try again.")).toBeTruthy();
  });

  it("lets only the latest question answer", async () => {
    let answerFirst!: (value: AdminRegistrationInvites) => void;
    mocks.listAdminRegistrationInvites
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValue(answer([invite("NEWERNEWER")]));
    show();
    fireEvent.click(screen.getByLabelText("Show revoked, expired and used up"));
    await screen.findByText("NEWERNEWER");
    answerFirst(answer([invite("OLDEROLDER")]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("OLDEROLDER")).toBeNull();
    expect(screen.getByText("NEWERNEWER")).toBeTruthy();
  });

  it("shows what was typed as text, never as markup", async () => {
    mocks.listAdminRegistrationInvites.mockResolvedValue(answer([invite("AAAAAAAAAA", { note: "<img src=x onerror=alert(1)>" })]));
    show();
    expect(await screen.findByText("Note: <img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("whether the codes matter", () => {
  it("says nothing when registration is on and invite-only", async () => {
    show();
    await screen.findByText("AAAAAAAAAA");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says so when registration is switched off", async () => {
    mocks.listAdminRegistrationInvites.mockResolvedValue(answer([invite("AAAAAAAAAA")], { registration: { enabled: false, inviteOnly: true } }));
    show();
    expect((await screen.findByRole("note")).textContent).toContain("Registration is switched off");
  });

  it("says so when the server is not invite-only, and that codes made now work once it is", async () => {
    mocks.listAdminRegistrationInvites.mockResolvedValue(answer([invite("AAAAAAAAAA")], { registration: { enabled: true, inviteOnly: false } }));
    show();
    const note = (await screen.findByRole("note")).textContent!;
    expect(note).toContain("not invite-only");
    expect(note).toContain("work once it is");
  });
});

describe("making invites", () => {
  const open = async () => {
    show();
    await screen.findByText("AAAAAAAAAA");
    fireEvent.click(screen.getByRole("button", { name: "Make invites…" }));
    return screen.findByRole("dialog", { name: "Make registration invites" });
  };

  it("starts with one use, a week and one code, and makes it in sudo mode", async () => {
    mocks.adminCreateRegistrationInvites.mockResolvedValue({ invites: [invite("NNNNNNNNNN")] });
    const dialog = await open();
    expect((within(dialog).getByLabelText("Accounts each code can make") as HTMLInputElement).value).toBe("1");
    expect((within(dialog).getByLabelText("Days until each code ends") as HTMLInputElement).value).toBe("7");
    expect((within(dialog).getByLabelText("How many codes to make") as HTMLInputElement).value).toBe("1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
    await confirmSudo();
    await waitFor(() => expect(mocks.adminCreateRegistrationInvites).toHaveBeenCalledWith({ maxUses: 1, expiresInDays: 7, note: undefined, count: 1 }, "sudo-1"));
    await waitFor(() => expect(mocks.listAdminRegistrationInvites).toHaveBeenCalledTimes(2));
    expect((await screen.findByText("Made 1 invite.")).textContent).toBe("Made 1 invite.");
  });

  it("takes no limit, no end, a note with the spaces off, and several codes", async () => {
    mocks.adminCreateRegistrationInvites.mockResolvedValue({ invites: [invite("NNNNNNNNN1"), invite("NNNNNNNNN2"), invite("NNNNNNNNN3")] });
    const dialog = await open();
    fireEvent.click(within(dialog).getByLabelText("No limit"));
    fireEvent.click(within(dialog).getByLabelText("Never ends"));
    expect((within(dialog).getByLabelText("Accounts each code can make") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("Days until each code ends") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Note/), { target: { value: "  Alex from work  " } });
    fireEvent.change(within(dialog).getByLabelText("How many codes to make"), { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
    await confirmSudo();
    await waitFor(() => expect(mocks.adminCreateRegistrationInvites).toHaveBeenCalledWith({ maxUses: null, expiresInDays: null, note: "Alex from work", count: 3 }, "sudo-1"));
    expect(await screen.findByText("Made 3 invites.")).toBeTruthy();
  });

  it("will not make anything from numbers the server would refuse, and says what is allowed", async () => {
    const dialog = await open();
    const make = within(dialog).getByRole("button", { name: "Make" }) as HTMLButtonElement;
    expect(make.disabled).toBe(false);
    for (const [label, value] of [
      ["Accounts each code can make", "0"],
      ["Accounts each code can make", "10001"],
      ["Days until each code ends", "3651"],
      ["Days until each code ends", "x"],
      ["How many codes to make", "51"],
      ["How many codes to make", ""],
    ] as const) {
      const field = within(dialog).getByLabelText(label) as HTMLInputElement;
      const before = field.value;
      fireEvent.change(field, { target: { value } });
      expect(make.disabled, `${label} = ${JSON.stringify(value)}`).toBe(true);
      expect(within(dialog).getByText(/Check the numbers/).textContent).toContain("1 to 10000");
      fireEvent.change(field, { target: { value: before } });
      expect(make.disabled).toBe(false);
    }
    // Nothing is asked of the server for a form that is wrong, even if it is submitted another way than by the button (Enter in a field).
    fireEvent.change(within(dialog).getByLabelText("How many codes to make"), { target: { value: "0" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await new Promise((r) => setTimeout(r, 30));
    // It does not even ask them to confirm it is them: the form is still open, wrong, and nothing was started.
    expect(screen.queryByRole("dialog", { name: "Confirm it is you" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Make registration invites" })).toBeTruthy();
    expect(mocks.adminSudo).not.toHaveBeenCalled();
    expect(mocks.adminCreateRegistrationInvites).not.toHaveBeenCalled();
  });

  it("makes nothing, and says nothing, when they back out of confirming it is them", async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
    const sudo = await screen.findByRole("dialog", { name: "Confirm it is you" });
    fireEvent.click(within(sudo).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.adminCreateRegistrationInvites).not.toHaveBeenCalled();
    expect(document.querySelector(".error-text")).toBeNull();
  });

  it("explains in words when the server refuses", async () => {
    mocks.adminCreateRegistrationInvites.mockRejectedValue(new ApiError(400, { error: "invalid_request" }));
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
    await confirmSudo();
    const message = await screen.findByText(/That was not accepted/);
    expect(message.className).toContain("error-text");
    expect(message.textContent).not.toContain("invalid_request");
  });

  it("cancels without asking anything", async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.adminSudo).not.toHaveBeenCalled();
  });
});

describe("copying", () => {
  it("copies a code, and a link to the register screen with that code in it", async () => {
    show();
    await screen.findByText("AAAAAAAAAA");
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("AAAAAAAAAA"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/register?invite=AAAAAAAAAA`));
  });

  it("copies all the codes just made, one to a line, or all the links", async () => {
    mocks.adminCreateRegistrationInvites.mockResolvedValue({ invites: [invite("NNNNNNNNN1"), invite("NNNNNNNNN2")] });
    show();
    await screen.findByText("AAAAAAAAAA");
    fireEvent.click(screen.getByRole("button", { name: "Make invites…" }));
    const dialog = await screen.findByRole("dialog", { name: "Make registration invites" });
    fireEvent.change(within(dialog).getByLabelText("How many codes to make"), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Make" }));
    await confirmSudo();
    fireEvent.click(await screen.findByRole("button", { name: "Copy the codes" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("NNNNNNNNN1\nNNNNNNNNN2"));
    fireEvent.click(screen.getByRole("button", { name: "Copy the links" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/register?invite=NNNNNNNNN1\n${window.location.origin}/register?invite=NNNNNNNNN2`)
    );
  });

  it("says so, and how to do it by hand, when the browser will not let it copy", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    show();
    await screen.findByText("AAAAAAAAAA");
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await screen.findByText(/Could not copy to the clipboard/)).toBeTruthy();
  });
});

describe("revoking", () => {
  it("asks first, then revokes that invite by its id in sudo mode and asks for the list again", async () => {
    mocks.adminRevokeRegistrationInvite.mockResolvedValue({ invite: invite("AAAAAAAAAA", { status: "revoked" }) });
    show();
    await screen.findByText("AAAAAAAAAA");
    fireEvent.click(screen.getByRole("button", { name: "Revoke…" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke this invite?" });
    expect(dialog.textContent).toContain("ending AAAA");
    expect(mocks.adminRevokeRegistrationInvite).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await confirmSudo();
    await waitFor(() => expect(mocks.adminRevokeRegistrationInvite).toHaveBeenCalledWith("id-AAAAAAAAAA", "sudo-1"));
    await waitFor(() => expect(mocks.listAdminRegistrationInvites).toHaveBeenCalledTimes(2));
  });

  it("does nothing when they decide not to", async () => {
    show();
    await screen.findByText("AAAAAAAAAA");
    fireEvent.click(screen.getByRole("button", { name: "Revoke…" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Revoke this invite?" })).getByRole("button", { name: "Cancel" }));
    expect(mocks.adminSudo).not.toHaveBeenCalled();
    expect(mocks.adminRevokeRegistrationInvite).not.toHaveBeenCalled();
  });

  it("takes a code it just revoked out of the notice about the codes just made", async () => {
    mocks.adminCreateRegistrationInvites.mockResolvedValue({ invites: [invite("NNNNNNNNN1")] });
    mocks.adminRevokeRegistrationInvite.mockResolvedValue({ invite: invite("NNNNNNNNN1", { status: "revoked" }) });
    mocks.listAdminRegistrationInvites.mockResolvedValue(answer([invite("NNNNNNNNN1")]));
    show();
    await screen.findByText("NNNNNNNNN1");
    fireEvent.click(screen.getByRole("button", { name: "Make invites…" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Make registration invites" })).getByRole("button", { name: "Make" }));
    await confirmSudo();
    await screen.findByText("Made 1 invite.");
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke…" })[0]);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Revoke this invite?" })).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(mocks.adminRevokeRegistrationInvite).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Made 1 invite.")).toBeNull());
  });
});
