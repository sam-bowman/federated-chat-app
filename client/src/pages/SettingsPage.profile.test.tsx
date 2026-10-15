import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";

const updateMe = vi.fn();
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  updateMe: (...args: unknown[]) => updateMe(...args),
}));

const refreshUser = vi.fn();
const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: auth.user, refreshUser }) }));
vi.mock("../components/AboutSection", () => ({ default: () => null }));
vi.mock("../components/RememberedAccountsSection", () => ({ default: () => null }));

function signedIn(over: Record<string, unknown> = {}) {
  auth.user = {
    id: "u1",
    identity: "@sam:chat.example",
    username: "sam",
    displayName: "Sam",
    avatarUrl: null,
    bio: null,
    pronouns: null,
    accentColor: null,
    totpEnabled: false,
    presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
    ...over,
  };
}

beforeEach(() => {
  updateMe.mockResolvedValue({});
  refreshUser.mockResolvedValue(undefined);
  signedIn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const preview = () => document.querySelector(".settings-profile-preview .profile-card") as HTMLElement;
const nameField = () => screen.getByDisplayValue(/^Sam/) as HTMLInputElement;
const pronounsField = () => screen.getByLabelText("Pronouns (optional)") as HTMLInputElement;
const bioField = () => screen.getByLabelText("Bio") as HTMLTextAreaElement;
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

describe("Settings -> Profile", () => {
  it("starts from what is saved", () => {
    signedIn({ displayName: "Sam", bio: "I map things", pronouns: "they/them", accentColor: "#1fb5a7" });
    render(<SettingsPage />);

    expect(nameField().value).toBe("Sam");
    expect(pronounsField().value).toBe("they/them");
    expect(bioField().value).toBe("I map things");
    expect(screen.getByRole("button", { name: /Profile colour: #1fb5a7/ })).toBeTruthy();
  });

  it("shows a live preview of the card others see, which follows what is typed before it is saved", () => {
    render(<SettingsPage />);
    expect(within(preview()).getByRole("heading", { name: "Sam" })).toBeTruthy();
    expect(within(preview()).queryByText("About")).toBeNull();

    fireEvent.change(nameField(), { target: { value: "Samantha" } });
    fireEvent.change(pronounsField(), { target: { value: "she/her" } });
    fireEvent.change(bioField(), { target: { value: "Cartographer" } });

    expect(within(preview()).getByRole("heading", { name: "Samantha" })).toBeTruthy();
    expect(within(preview()).getByText("she/her")).toBeTruthy();
    expect(within(preview()).getByText("Cartographer")).toBeTruthy();
    expect(updateMe).not.toHaveBeenCalled();
  });

  it("keeps the saved name in the preview while the name box is empty, rather than showing nothing", () => {
    render(<SettingsPage />);

    fireEvent.change(nameField(), { target: { value: "   " } });

    expect(within(preview()).getByRole("heading", { name: "Sam" })).toBeTruthy();
  });

  it("shows the preview in the chosen colour straight away", () => {
    signedIn({ accentColor: "#e0a030" });
    render(<SettingsPage />);

    expect(preview().style.getPropertyValue("--profile-accent")).toBe("#e0a030");
  });

  it("shows markup typed into a field as text in the preview", () => {
    render(<SettingsPage />);

    fireEvent.change(bioField(), { target: { value: "<img src=x onerror=alert(1)>" } });

    expect(preview().querySelector("img")).toBeNull();
    expect(within(preview()).getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });

  it("saves the name, bio, pronouns and colour together, then refreshes the signed-in user", async () => {
    signedIn({ accentColor: "#e0a030" });
    render(<SettingsPage />);
    fireEvent.change(nameField(), { target: { value: "Samantha" } });
    fireEvent.change(pronounsField(), { target: { value: "  she/her " } });
    fireEvent.change(bioField(), { target: { value: "Cartographer" } });

    save();

    await waitFor(() =>
      expect(updateMe).toHaveBeenCalledWith({
        displayName: "Samantha",
        bio: "Cartographer",
        pronouns: "she/her",
        accentColor: "#e0a030",
      })
    );
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Saved!" })).toBeTruthy();
  });

  it("sends nothing for empty fields, which clears them", async () => {
    signedIn({ bio: "old", pronouns: "they/them", accentColor: "#e0a030" });
    render(<SettingsPage />);
    fireEvent.change(pronounsField(), { target: { value: "   " } });
    fireEvent.change(bioField(), { target: { value: "" } });

    save();

    await waitFor(() =>
      expect(updateMe).toHaveBeenCalledWith({ displayName: "Sam", bio: null, pronouns: null, accentColor: "#e0a030" })
    );
  });

  it("limits the pronouns box to what the server accepts", () => {
    render(<SettingsPage />);

    expect(pronounsField().maxLength).toBe(32);
    expect(bioField().maxLength).toBe(512);
  });

  it("says so when saving fails, and does not claim it saved", async () => {
    updateMe.mockRejectedValue(new Error("400"));
    render(<SettingsPage />);

    save();

    expect((await screen.findByText(/Couldn't save your profile/)).getAttribute("role")).toBe("alert");
    expect(refreshUser).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Saved!" })).toBeNull();
  });

  it("clears an earlier failure when the next save works", async () => {
    updateMe.mockRejectedValueOnce(new Error("400"));
    render(<SettingsPage />);
    save();
    await screen.findByText(/Couldn't save your profile/);

    save();

    await waitFor(() => expect(screen.queryByText(/Couldn't save your profile/)).toBeNull());
  });
});
