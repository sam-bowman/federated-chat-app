import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import DeleteAccountSection from "./DeleteAccountSection";

const state = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  logout: vi.fn(),
  deleteMyAccount: vi.fn(),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: state.user, logout: state.logout }) }));
vi.mock("../api", () => ({ deleteMyAccount: (...args: unknown[]) => state.deleteMyAccount(...args) }));

beforeEach(() => {
  state.user = { id: "me", username: "alice", totpEnabled: false };
  state.logout.mockReset();
  state.deleteMyAccount.mockReset().mockResolvedValue({ scheduledFor: "2026-02-01T12:00:00.000Z", graceDays: 14 });
});
afterEach(cleanup);

const open = () => fireEvent.click(screen.getByRole("button", { name: /Delete my account…/ }));
const password = () => screen.getByLabelText("Your password");
const username = () => screen.getByLabelText(/Type your username/);
const submit = () => screen.getByRole("button", { name: "Delete my account" }) as HTMLButtonElement;
const fill = (pw: string, typed: string) => {
  fireEvent.change(password(), { target: { value: pw } });
  fireEvent.change(username(), { target: { value: typed } });
};
const rejectWith = (status: number, body: unknown) => state.deleteMyAccount.mockRejectedValue(new ApiError(status, body));

describe("Settings -> Delete account", () => {
  it("says what happens, and shows nothing to type until the person chooses to go on", () => {
    render(<DeleteAccountSection />);
    expect(screen.getByText(/signing in again before then/i)).toBeTruthy();
    expect(screen.getByText(/own a community/i)).toBeTruthy();
    expect(screen.queryByLabelText("Your password")).toBeNull();
    open();
    expect(password()).toBeTruthy();
  });

  it("cannot be sent until the password is given and the username typed out", () => {
    render(<DeleteAccountSection />);
    open();
    expect(submit().disabled).toBe(true);
    fill("pw", "ali");
    expect(submit().disabled).toBe(true);
    fill("", "alice");
    expect(submit().disabled).toBe(true);
    fill("pw", " ALICE ");
    expect(submit().disabled).toBe(false);
  });

  it("can be backed out of", () => {
    render(<DeleteAccountSection />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Your password")).toBeNull();
    expect(state.deleteMyAccount).not.toHaveBeenCalled();
  });

  it("asks, then says when the account will be erased and that signing in cancels it", async () => {
    render(<DeleteAccountSection />);
    open();
    fill("pw", "alice");
    fireEvent.click(submit());

    await screen.findByRole("status");
    expect(state.deleteMyAccount).toHaveBeenCalledWith({ password: "pw", username: "alice" });
    expect(screen.getByRole("status").textContent).toContain("Sign in again before then to cancel it");
    expect(screen.getByRole("status").textContent).toContain(new Date("2026-02-01T12:00:00.000Z").toLocaleString());
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(state.logout).toHaveBeenCalled();
  });

  it("asks for a code when two-factor sign-in is on, and sends a six-digit one as a code and a longer one as a recovery code", async () => {
    state.user = { id: "me", username: "alice", totpEnabled: true };
    render(<DeleteAccountSection />);
    open();
    fill("pw", "alice");
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Code from your authenticator/), { target: { value: " 123456 " } });
    fireEvent.click(submit());
    await waitFor(() => expect(state.deleteMyAccount).toHaveBeenCalledWith({ password: "pw", username: "alice", code: "123456" }));

    cleanup();
    state.deleteMyAccount.mockClear();
    render(<DeleteAccountSection />);
    open();
    fill("pw", "alice");
    fireEvent.change(screen.getByLabelText(/Code from your authenticator/), { target: { value: "abcd-efgh-ijkl" } });
    fireEvent.click(submit());
    await waitFor(() => expect(state.deleteMyAccount).toHaveBeenCalledWith({ password: "pw", username: "alice", recoveryCode: "abcd-efgh-ijkl" }));
  });

  it("does not ask for a code when there is no two-factor sign-in", () => {
    render(<DeleteAccountSection />);
    open();
    expect(screen.queryByLabelText(/Code from your authenticator/)).toBeNull();
  });

  it("lists the communities that are in the way, and stays as it was", async () => {
    rejectWith(409, { error: "owns_communities", communities: [{ id: "c1", name: "Book Club" }, { id: "c2", name: "Chess" }] });
    render(<DeleteAccountSection />);
    open();
    fill("pw", "alice");
    fireEvent.click(submit());

    await screen.findByText(/You still own a community/);
    expect(screen.getByText("Book Club")).toBeTruthy();
    expect(screen.getByText("Chess")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(state.logout).not.toHaveBeenCalled();
  });

  it.each([
    [401, { error: "invalid_credentials" }, "That is not your password."],
    [401, { error: "invalid_code" }, "That code is not right"],
    [400, { error: "username_mismatch" }, "Type your username exactly"],
    [429, null, "Too many tries"],
    [500, null, "Couldn't ask for the account to be deleted"],
  ])("explains a refusal (%s %j)", async (status, body, words) => {
    rejectWith(status, body);
    render(<DeleteAccountSection />);
    open();
    fill("pw", "alice");
    fireEvent.click(submit());
    expect((await screen.findByText(new RegExp(words))).textContent).toContain(words);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws nothing when nobody is signed in", () => {
    state.user = null;
    const { container } = render(<DeleteAccountSection />);
    expect(container.firstChild).toBeNull();
  });
});
