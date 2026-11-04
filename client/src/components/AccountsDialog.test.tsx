import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountsDialog from "./AccountsDialog";
import { startSession, type AccountSession } from "../lib/accountSessions";

const mockAuth = vi.hoisted(() => ({ switchAccount: vi.fn(), signOutAccount: vi.fn(), user: { identity: "@alice:alice.test" } }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => mockAuth }));

const server = { domain: "alice.test", serverName: "Alice's server", registrationEnabled: true };
const A = "http://localhost:4000";
const B = "https://chat.bob.test";

let alice: AccountSession;
let bob: AccountSession;
beforeEach(() => {
  // Picker mode, whatever client/.env says on this machine: in a fixed-server deployment only accounts on its one server are listed.
  import.meta.env.VITE_API_URL = "";
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  bob = startSession({ ...server, origin: B, domain: "chat.bob.test", serverName: "Bob's place", username: "bob", accessToken: "b", refreshToken: "br" });
  alice = startSession({ ...server, origin: A, username: "alice", accessToken: "a", refreshToken: "ar" }); // this tab uses her
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

const open = (onAddAccount = vi.fn(), onClose = vi.fn()) => {
  render(<AccountsDialog onClose={onClose} onAddAccount={onAddAccount} />);
  return { onAddAccount, onClose };
};

describe("AccountsDialog", () => {
  it("lists every account signed in on this device, and says which is in use", () => {
    open();

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("@alice:alice.test")).toBeTruthy();
    expect(screen.getByText("@bob:chat.bob.test")).toBeTruthy();
    expect(screen.getByText(/Alice's server · in use/)).toBeTruthy();
    expect(screen.getByText("Bob's place")).toBeTruthy();
  });

  it("offers to switch to the others only, not to the account already in use", () => {
    open();

    expect(screen.queryByRole("button", { name: "Switch to @alice:alice.test" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch to @bob:chat.bob.test" }));
    expect(mockAuth.switchAccount).toHaveBeenCalledWith(bob.id);
  });

  it("signs an account out, and an account that is not in use leaves the list at once", () => {
    open();

    fireEvent.click(screen.getByRole("button", { name: "Sign out @bob:chat.bob.test" }));
    expect(mockAuth.signOutAccount).toHaveBeenCalledWith(bob.id);
    // the (mocked) sign-out does not touch storage, so this only proves the click is passed on: the real one is tested in AuthContext
    fireEvent.click(screen.getByRole("button", { name: "Sign out @alice:alice.test" }));
    expect(mockAuth.signOutAccount).toHaveBeenCalledWith(alice.id);
  });

  it("closes itself and goes to the sign-in page to add another account", () => {
    const { onAddAccount, onClose } = open();

    fireEvent.click(screen.getByRole("button", { name: "Add another account" }));

    expect(onClose).toHaveBeenCalled();
    expect(onAddAccount).toHaveBeenCalled();
  });

  it("shows what a server calls itself as text only", () => {
    localStorage.clear();
    startSession({ ...server, origin: B, serverName: "<img src=x onerror=alert(1)>", username: "bob", accessToken: "b", refreshToken: "br" });
    const { baseElement } = render(<AccountsDialog onClose={vi.fn()} onAddAccount={vi.fn()} />);

    expect(baseElement.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
  });
});
