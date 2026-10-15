import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import PrivacySection from "./PrivacySection";

const state = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  refreshUser: vi.fn(),
  updateMe: vi.fn(),
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: state.user, refreshUser: state.refreshUser }) }));
vi.mock("../api", () => ({ updateMe: (...args: unknown[]) => state.updateMe(...args) }));

beforeEach(() => {
  state.user = { id: "me", username: "me", discoverable: true, discoverabilityLocked: false };
  state.refreshUser.mockReset().mockResolvedValue(undefined);
  state.updateMe.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

const box = () => screen.getByRole("checkbox", { name: "Let people on other servers find me" }) as HTMLInputElement;

describe("Settings -> Privacy", () => {
  it("shows the person as findable, and says what that means", () => {
    render(<PrivacySection />);

    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(false);
    expect(screen.getByText(/Anyone on another server can look you up/)).toBeTruthy();
  });

  it("hides them when it is switched off, then reloads who they are", async () => {
    render(<PrivacySection />);

    fireEvent.click(box());

    await waitFor(() => expect(state.updateMe).toHaveBeenCalledWith({ discoverable: false }));
    await waitFor(() => expect(state.refreshUser).toHaveBeenCalled());
  });

  it("says what hiding means: strangers are told they do not exist, what they have carries on", () => {
    state.user = { id: "me", username: "me", discoverable: false, discoverabilityLocked: false };
    render(<PrivacySection />);

    expect(box().checked).toBe(false);
    expect(screen.getByText(/told you don't exist/)).toBeTruthy();
    expect(screen.getByText(/already have with a server carries on/)).toBeTruthy();
    expect(screen.getByText(/people on your own server can still find you/)).toBeTruthy();
  });

  it("makes them findable again when it is switched on", async () => {
    state.user = { id: "me", username: "me", discoverable: false, discoverabilityLocked: false };
    render(<PrivacySection />);

    fireEvent.click(box());

    await waitFor(() => expect(state.updateMe).toHaveBeenCalledWith({ discoverable: true }));
  });

  it("shows the switch off and cannot be changed when the server has taken the choice away, and says so", () => {
    state.user = { id: "me", username: "me", discoverable: true, discoverabilityLocked: true };
    render(<PrivacySection />);

    expect(box().checked).toBe(false); // whatever was chosen before, it is not what is in force
    expect(box().disabled).toBe(true);
    expect(screen.getByText(/This server has turned this off for everyone/)).toBeTruthy();
  });

  it("says so if the server refuses because it has taken the choice away since the page loaded", async () => {
    state.updateMe.mockRejectedValue(new ApiError(409, { error: "discoverability_locked" }));
    render(<PrivacySection />);

    fireEvent.click(box());

    expect(await screen.findByText("This server has turned this off for everyone.")).toBeTruthy();
  });

  it("says it could not save for any other failure", async () => {
    state.updateMe.mockRejectedValue(new ApiError(500, { error: "internal_error" }));
    render(<PrivacySection />);

    fireEvent.click(box());

    expect(await screen.findByText("Couldn't save that. Try again.")).toBeTruthy();
  });

  it("shows nothing on a server that predates the setting, since there is nothing to change", () => {
    state.user = { id: "me", username: "me" };
    const { container } = render(<PrivacySection />);

    expect(container.textContent).toBe("");
  });
});
