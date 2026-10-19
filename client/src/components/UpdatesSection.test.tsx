import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({ check: vi.fn() }));
const processPlugin = vi.hoisted(() => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => plugin);
vi.mock("@tauri-apps/plugin-process", () => processPlugin);
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("0.15.0") }));

import { checkForUpdate, resetUpdaterForTests } from "../lib/updater";
import UpdateBanner from "./UpdateBanner";
import UpdatesSection from "./UpdatesSection";

function fakeUpdate(version = "0.16.0") {
  return {
    version,
    currentVersion: "0.15.0",
    body: "Fixes and <b>things</b>",
    close: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
  };
}

const setDesktop = (on: boolean) => {
  if (on) (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
};

beforeEach(() => {
  localStorage.clear();
  setDesktop(true);
  plugin.check.mockReset();
  processPlugin.relaunch.mockReset().mockResolvedValue(undefined);
  resetUpdaterForTests();
});

afterEach(() => {
  cleanup();
  resetUpdaterForTests();
  setDesktop(false);
  localStorage.clear();
});

describe("Settings -> Updates", () => {
  it("is not there in a browser, where the server the page came from is what updates it", () => {
    setDesktop(false);
    const { container } = render(<UpdatesSection />);
    expect(container.textContent).toBe("");
  });

  it("has automatic updates on by default, and turning it off is remembered", () => {
    render(<UpdatesSection />);
    const box = screen.getByRole("checkbox", { name: "Update automatically" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText(/downloads a new version in the background/)).not.toBeNull();

    fireEvent.click(box);

    expect(box.checked).toBe(false);
    expect(localStorage.getItem("chat.autoUpdate")).toBe("false");
    expect(screen.getByText(/does not check by itself/)).not.toBeNull();

    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(localStorage.getItem("chat.autoUpdate")).toBeNull();
  });

  it("starts from a remembered 'off'", () => {
    localStorage.setItem("chat.autoUpdate", "false");
    resetUpdaterForTests();
    render(<UpdatesSection />);
    expect((screen.getByRole("checkbox", { name: "Update automatically" }) as HTMLInputElement).checked).toBe(false);
  });

  it("says which version is installed, as the app itself reports it", async () => {
    render(<UpdatesSection />);
    await screen.findByText("You have v0.15.0.");
  });

  it("checks when the button is pressed, even with automatic updates off, and says it is up to date", async () => {
    localStorage.setItem("chat.autoUpdate", "false");
    resetUpdaterForTests();
    plugin.check.mockResolvedValue(null);
    render(<UpdatesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await screen.findByText("You are up to date (v0.15.0).");
    expect(plugin.check).toHaveBeenCalledOnce();
  });

  it("disables the button while it is checking", async () => {
    let resolve!: (value: null) => void;
    plugin.check.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<UpdatesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await screen.findByText("Checking for updates…");
    expect((screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(null));
  });

  it("offers a version it found and updates on request", async () => {
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    render(<UpdatesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update to v0.16.0" }));

    await waitFor(() => expect(processPlugin.relaunch).toHaveBeenCalledOnce());
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).toHaveBeenCalledOnce();
  });

  it("shows the notes of an update that is available as plain text, never as markup", async () => {
    plugin.check.mockResolvedValue(fakeUpdate());
    const { container } = render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("Version 0.16.0 is available.");
    expect(container.querySelector(".update-notes")!.textContent).toBe("Fixes and <b>things</b>");
    expect(container.querySelector(".update-notes b")).toBeNull();
  });

  it("offers a restart for one that is already downloaded, and installs on request", async () => {
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    render(<UpdatesSection />);
    await act(async () => checkForUpdate({ automatic: true }));

    expect(await screen.findByText(/is downloaded and ready/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Restart to update to v0.16.0" }));

    await waitFor(() => expect(update.install).toHaveBeenCalledOnce());
    expect(update.download).toHaveBeenCalledOnce();
  });

  it("says why it failed, and lets you try again", async () => {
    plugin.check.mockRejectedValue(new Error("could not reach the update server"));
    render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("Couldn't update: could not reach the update server");
    expect((screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the 'ready to install' banner", () => {
  it("appears once a version is downloaded, and not before", async () => {
    plugin.check.mockResolvedValue(fakeUpdate());
    render(<UpdateBanner />);
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => checkForUpdate());
    expect(screen.queryByRole("status")).toBeNull();

    resetUpdaterForTests();
    await act(async () => checkForUpdate({ automatic: true }));
    expect(screen.getByRole("status").textContent).toContain("Version 0.16.0 is ready.");
  });

  it("goes away with Later, without installing, until a newer version arrives", async () => {
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    render(<UpdateBanner />);
    await act(async () => checkForUpdate({ automatic: true }));

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(update.install).not.toHaveBeenCalled();

    resetUpdaterForTests();
    plugin.check.mockResolvedValue(fakeUpdate("0.17.0"));
    await act(async () => checkForUpdate({ automatic: true }));
    expect(screen.getByRole("status").textContent).toContain("0.17.0");
  });

  it("restarts into the update from its button", async () => {
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    render(<UpdateBanner />);
    await act(async () => checkForUpdate({ automatic: true }));

    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));

    await waitFor(() => expect(processPlugin.relaunch).toHaveBeenCalledOnce());
  });

  it("is never shown in a browser", async () => {
    plugin.check.mockResolvedValue(fakeUpdate());
    await act(async () => checkForUpdate({ automatic: true }));
    setDesktop(false);
    const { container } = render(<UpdateBanner />);
    expect(container.textContent).toBe("");
  });
});
