import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";

const uploadFile = vi.fn();
const updateMe = vi.fn();
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
  updateMe: (...args: unknown[]) => updateMe(...args),
}));

const refreshUser = vi.fn();
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      identity: "@sam:chat.example",
      username: "sam",
      displayName: "Sam",
      avatarUrl: null,
      bio: null,
      totpEnabled: false,
      presence: { status: "ONLINE", customStatus: null, lastSeenAt: null },
    },
    refreshUser,
  }),
}));
vi.mock("../components/AboutSection", () => ({ default: () => null }));
vi.mock("../components/RememberedAccountsSection", () => ({ default: () => null }));

beforeEach(() => {
  uploadFile.mockResolvedValue({ url: "/uploads/new.png" });
  updateMe.mockResolvedValue({});
  refreshUser.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const picture = () => new File(["x"], "face.png", { type: "image/png" });
const nativeInput = () => document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement;
const choose = (file: File) => fireEvent.change(nativeInput(), { target: { files: [file] } });

describe("Settings -> your picture", () => {
  it("shows it large, with the button beside it", () => {
    const { container } = render(<SettingsPage />);

    expect(container.querySelector(".settings-avatar .avatar.xl")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Change avatar" })).toBeTruthy();
  });

  it("uploads the chosen picture, sets it as the avatar, and refreshes the signed-in user", async () => {
    render(<SettingsPage />);
    const file = picture();

    choose(file);

    await waitFor(() => expect(updateMe).toHaveBeenCalledWith({ avatarUrl: "/uploads/new.png" }));
    expect(uploadFile).toHaveBeenCalledWith(file);
    expect(refreshUser).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The upload route also takes documents and video, so without this a PDF became somebody's "avatar".
  it("refuses a file that is not a picture, without uploading it", () => {
    render(<SettingsPage />);

    choose(new File(["x"], "notes.pdf", { type: "application/pdf" }));

    expect(screen.getByRole("alert").textContent).toContain("isn't a picture");
    expect(uploadFile).not.toHaveBeenCalled();
    expect(updateMe).not.toHaveBeenCalled();
  });

  it("says so when the upload fails, and leaves the avatar as it was", async () => {
    uploadFile.mockRejectedValue(new Error("too large"));
    render(<SettingsPage />);

    choose(picture());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Couldn't use that picture"));
    expect(updateMe).not.toHaveBeenCalled();
    expect(refreshUser).not.toHaveBeenCalled();
    // and the button is usable again
    expect((screen.getByRole("button", { name: "Change avatar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("is busy while uploading, so it cannot be started twice", async () => {
    let finish!: (value: { url: string }) => void;
    uploadFile.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<SettingsPage />);

    choose(picture());

    const busy = await screen.findByRole("button", { name: "Uploading…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    finish({ url: "/uploads/new.png" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Change avatar" })).toBeTruthy());
  });

  it("clears an earlier error when a new attempt works", async () => {
    render(<SettingsPage />);
    choose(new File(["x"], "notes.pdf", { type: "application/pdf" }));
    expect(screen.getByRole("alert")).toBeTruthy();

    choose(picture());

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
