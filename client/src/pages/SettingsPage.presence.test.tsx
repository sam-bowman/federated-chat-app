import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";

const setPresence = vi.fn();
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  setPresence: (...args: unknown[]) => setPresence(...args),
}));

const refreshUser = vi.fn();
const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: auth.user, refreshUser }) }));
vi.mock("../components/AboutSection", () => ({ default: () => null }));
vi.mock("../components/RememberedAccountsSection", () => ({ default: () => null }));

function signedIn(presence: { status: string; customStatus: string | null }) {
  auth.user = {
    id: "u1",
    identity: "@sam:chat.example",
    username: "sam",
    displayName: "Sam",
    avatarUrl: null,
    bio: null,
    totpEnabled: false,
    presence: { ...presence, lastSeenAt: null },
  };
}

beforeEach(() => {
  setPresence.mockResolvedValue({});
  refreshUser.mockResolvedValue(undefined);
  signedIn({ status: "ONLINE", customStatus: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const field = () => screen.getByRole("textbox", { name: "Custom status" }) as HTMLInputElement;

describe("Settings -> Presence", () => {
  it("offers the same five statuses as the footer menu, in the same words, marking the current one", () => {
    signedIn({ status: "DO_NOT_DISTURB", customStatus: null });
    render(<SettingsPage />);

    for (const label of ["Online", "Away", "Busy", "Do not disturb", "Invisible"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Do not disturb" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Online" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("changes the status and refreshes the signed-in user, which is what the footer reads", async () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Busy" }));

    await waitFor(() => expect(setPresence).toHaveBeenCalledWith({ status: "BUSY" }));
    expect(refreshUser).toHaveBeenCalled();
  });

  it("shows the saved custom status", () => {
    signedIn({ status: "ONLINE", customStatus: "in a meeting" });
    render(<SettingsPage />);

    expect(field().value).toBe("in a meeting");
  });

  it("sets and clears the custom status through the same call the footer uses", async () => {
    signedIn({ status: "ONLINE", customStatus: "in a meeting" });
    render(<SettingsPage />);

    fireEvent.change(field(), { target: { value: "lunch" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    await waitFor(() => expect(setPresence).toHaveBeenCalledWith({ customStatus: "lunch" }));

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(setPresence).toHaveBeenCalledWith({ customStatus: null }));
    expect(refreshUser).toHaveBeenCalledTimes(2);
  });

  // The bug this guards: Settings used to copy the saved text into its own state once, so a status changed from
  // the footer (visible beside this page) left the field showing the old one.
  it("follows a custom status changed from somewhere else, such as the footer, instead of keeping a stale copy", () => {
    signedIn({ status: "ONLINE", customStatus: "in a meeting" });
    const { rerender } = render(<SettingsPage />);
    expect(field().value).toBe("in a meeting");

    signedIn({ status: "ONLINE", customStatus: "at lunch" });
    rerender(<SettingsPage />);

    expect(field().value).toBe("at lunch");
  });

  it("drops a half-typed draft when the saved status changes elsewhere, rather than overwriting it later", () => {
    const { rerender } = render(<SettingsPage />);
    fireEvent.change(field(), { target: { value: "half typed" } });

    signedIn({ status: "ONLINE", customStatus: "set from the footer" });
    rerender(<SettingsPage />);

    expect(field().value).toBe("set from the footer");
  });
});
