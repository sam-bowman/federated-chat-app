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

describe("Settings -> Privacy -> who can send me friend requests and start conversations", () => {
  const group = () => screen.getByRole("group", { name: "Who can send me friend requests and start conversations" });
  const choice = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;

  it("offers the three choices as a group of radio buttons, with the current one selected", () => {
    state.user = { id: "me", username: "me", discoverable: true, contactPolicy: "SHARED_COMMUNITY" };
    render(<PrivacySection />);

    expect(group()).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(choice(/^People I share a community with/).checked).toBe(true);
    expect(choice(/^Anyone/).checked).toBe(false);
    expect(choice(/^People on this server/).checked).toBe(false);
  });

  it("saves the one that is chosen, then reloads who they are", async () => {
    state.user = { id: "me", username: "me", discoverable: true, contactPolicy: "ANYONE" };
    render(<PrivacySection />);

    fireEvent.click(choice(/^People on this server/));

    await waitFor(() => expect(state.updateMe).toHaveBeenCalledWith({ contactPolicy: "LOCAL_ONLY" }));
    await waitFor(() => expect(state.refreshUser).toHaveBeenCalled());
  });

  it("moves to the choice at once, while it is being saved, and back if saving fails", async () => {
    state.user = { id: "me", username: "me", discoverable: true, contactPolicy: "ANYONE" };
    let fail: (reason: unknown) => void = () => {};
    state.updateMe.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    render(<PrivacySection />);

    fireEvent.click(choice(/^People on this server/));

    expect(choice(/^People on this server/).checked).toBe(true); // before the server has answered
    expect(choice(/^Anyone/).checked).toBe(false);
    fail(new ApiError(500, { error: "internal_error" }));
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeTruthy();
    expect(choice(/^Anyone/).checked).toBe(true); // what is really saved
  });

  it("says that friends are always let in and what already exists is not affected", () => {
    state.user = { id: "me", username: "me", discoverable: true, contactPolicy: "ANYONE" };
    render(<PrivacySection />);

    expect(screen.getByText(/Your friends can always write to you, and conversations you already have are not affected/)).toBeTruthy();
  });

  it("is shown on its own for a server that has this setting but not the findable one", () => {
    state.user = { id: "me", username: "me", contactPolicy: "ANYONE" };
    render(<PrivacySection />);

    expect(group()).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("is not shown by a server that predates it, whatever else is", () => {
    state.user = { id: "me", username: "me", discoverable: true };
    render(<PrivacySection />);

    expect(screen.queryByRole("group")).toBeNull();
    expect(box()).toBeTruthy();
  });

  it("says it could not save when the server refuses", async () => {
    state.user = { id: "me", username: "me", discoverable: true, contactPolicy: "ANYONE" };
    state.updateMe.mockRejectedValue(new ApiError(500, { error: "internal_error" }));
    render(<PrivacySection />);

    fireEvent.click(choice(/^People on this server/));

    expect(await screen.findByText("Couldn't save that. Try again.")).toBeTruthy();
  });
});

describe("Settings -> Privacy -> the directory of people", () => {
  const listed = () => screen.getByRole("checkbox", { name: "List me in this server's directory of people" }) as HTMLInputElement;

  it("is off to begin with, says what turning it on does, and saves when it is", async () => {
    state.user = { id: "me", username: "me", discoverable: true, listedInDirectory: false, directoryEnabled: true };
    render(<PrivacySection />);

    expect(listed().checked).toBe(false);
    expect(screen.getByText(/Off: you aren't listed/)).toBeTruthy();
    fireEvent.click(listed());

    await waitFor(() => expect(state.updateMe).toHaveBeenCalledWith({ listedInDirectory: true }));
  });

  it("is turned off the same way, and saves that", async () => {
    state.user = { id: "me", username: "me", discoverable: true, listedInDirectory: true, directoryEnabled: true };
    render(<PrivacySection />);

    fireEvent.click(listed());

    await waitFor(() => expect(state.updateMe).toHaveBeenCalledWith({ listedInDirectory: false }));
  });

  it("says what being listed shows, once it is on", () => {
    state.user = { id: "me", username: "me", discoverable: true, listedInDirectory: true, directoryEnabled: true };
    render(<PrivacySection />);

    expect(listed().checked).toBe(true);
    expect(screen.getByText(/can see your name, picture and bio and send you a friend request/)).toBeTruthy();
  });

  it("says nothing is listed anywhere yet when the server publishes no directory, and keeps the choice", () => {
    state.user = { id: "me", username: "me", discoverable: true, listedInDirectory: true, directoryEnabled: false };
    render(<PrivacySection />);

    expect(listed().checked).toBe(true);
    expect(screen.getByText(/doesn't publish a directory, so you won't be listed anywhere yet/)).toBeTruthy();
  });

  it("says you are not listed while hidden from other servers, hiding winning over listing", () => {
    state.user = { id: "me", username: "me", discoverable: false, listedInDirectory: true, directoryEnabled: true };
    render(<PrivacySection />);

    expect(screen.getByText(/You're not listed while other servers can't find you/)).toBeTruthy();
  });

  it("cannot be changed where the server has taken findability away, and says so", () => {
    state.user = { id: "me", username: "me", discoverable: true, discoverabilityLocked: true, listedInDirectory: false, directoryEnabled: true };
    render(<PrivacySection />);

    expect(listed().disabled).toBe(true);
    expect(screen.getByText(/This server has turned this off for everyone, so nobody is listed/)).toBeTruthy();
  });

  it("is not shown by a server that predates the directory", () => {
    state.user = { id: "me", username: "me", discoverable: true };
    render(<PrivacySection />);

    expect(screen.queryByRole("checkbox", { name: "List me in this server's directory of people" })).toBeNull();
  });
});

describe("Settings -> Privacy -> what the server limits", () => {
  it("says who a server's limit lets in, above the choices, when it has one", () => {
    state.user = { id: "me", username: "me", discoverable: true, contactPolicy: "ANYONE", contactPolicyLimit: "LOCAL_ONLY" };
    render(<PrivacySection />);

    expect(screen.getByText(/This server only lets people on this server send friend requests or start conversations, whatever you choose here/)).toBeTruthy();
    // The person can still choose; their choice only narrows it.
    expect(screen.getAllByRole("radio").every((r) => !(r as HTMLInputElement).disabled)).toBe(true);
  });

  it("says nothing about a limit when there is none", () => {
    state.user = { id: "me", username: "me", discoverable: true, contactPolicy: "ANYONE", contactPolicyLimit: "ANYONE" };
    render(<PrivacySection />);

    expect(screen.queryByText(/This server only lets/)).toBeNull();
  });

  it("disables listing, and says why, where the server lists nobody", () => {
    state.user = { id: "me", username: "me", discoverable: true, listedInDirectory: false, directoryEnabled: true, directoryPeopleLocked: true };
    render(<PrivacySection />);

    const box = screen.getByRole("checkbox", { name: "List me in this server's directory of people" }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/This server has turned this off for everyone, so nobody is listed/)).toBeTruthy();
  });

  it("says so if the server refuses to change listing because it lists nobody", async () => {
    state.user = { id: "me", username: "me", discoverable: true, listedInDirectory: false, directoryEnabled: true };
    state.updateMe.mockRejectedValue(new ApiError(409, { error: "directory_listing_locked" }));
    render(<PrivacySection />);

    fireEvent.click(screen.getByRole("checkbox", { name: "List me in this server's directory of people" }));

    expect(await screen.findByText("This server has turned this off for everyone.")).toBeTruthy();
  });
});
