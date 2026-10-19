import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPrefs, indexPrefs } from "../lib/notificationPrefs";

const h = vi.hoisted(() => ({ prefs: null as unknown, update: vi.fn() }));
vi.mock("../context/NotificationSettingsContext", () => ({ useNotificationSettings: () => ({ prefs: h.prefs, update: h.update }) }));

import NotificationBell from "./NotificationBell";
import type { NotificationTarget } from "./NotificationSettingsModal";

const channel: NotificationTarget = { kind: "channel", id: "ch1", name: "general", communityId: "co1", communityName: "Club" };
const conversation: NotificationTarget = { kind: "conversation", id: "c1", name: "Alice" };

beforeEach(() => {
  h.prefs = emptyPrefs();
  h.update.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

const open = () => fireEvent.click(screen.getByRole("button", { name: /Sound and notifications/ }));
const dialog = () => screen.getByRole("dialog");

describe("the bell", () => {
  it("is not named like the Settings button, which people and tests find by that word", () => {
    render(<NotificationBell target={conversation} />);
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
  });

  it("shows a bell when something is on and a muted bell when nothing is", () => {
    const { rerender } = render(<NotificationBell target={conversation} />);
    expect(screen.getByRole("button", { name: "Sound and notifications" }).textContent).toBe("🔔");

    h.prefs = indexPrefs([{ type: "CONVERSATION", id: "c1", sound: false, notify: false }]);
    rerender(<NotificationBell target={conversation} />);
    expect(screen.getByRole("button", { name: "Sound and notifications (muted)" }).textContent).toBe("🔕");

    // One of the two on is not muted.
    h.prefs = indexPrefs([{ type: "CONVERSATION", id: "c1", sound: false, notify: null }]);
    rerender(<NotificationBell target={conversation} />);
    expect(screen.getByRole("button", { name: "Sound and notifications" }).textContent).toBe("🔔");
  });

  it("is muted when the whole community is muted and the channel has no choice, and not when the channel has its own", () => {
    h.prefs = indexPrefs([{ type: "COMMUNITY", id: "co1", sound: false, notify: false }]);
    const { rerender } = render(<NotificationBell target={channel} />);
    expect(screen.getByRole("button", { name: "Sound and notifications (muted)" })).not.toBeNull();

    h.prefs = indexPrefs([
      { type: "COMMUNITY", id: "co1", sound: false, notify: false },
      { type: "CHANNEL", id: "ch1", sound: true, notify: null },
    ]);
    rerender(<NotificationBell target={channel} />);
    expect(screen.getByRole("button", { name: "Sound and notifications" })).not.toBeNull();
  });

  it("opens a dialog titled for the place, and closes with Escape", () => {
    render(<NotificationBell target={channel} />);
    open();
    expect(screen.getByRole("dialog", { name: "Notifications for #general" })).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a conversation's notification settings", () => {
  it("has a sound choice and a notification choice, each Default until chosen", () => {
    render(<NotificationBell target={conversation} />);
    open();
    expect(screen.getByRole("dialog", { name: "Notifications for Alice" })).not.toBeNull();
    expect((within(dialog()).getByLabelText("Sound") as HTMLSelectElement).value).toBe("default");
    expect((within(dialog()).getByLabelText("System notification") as HTMLSelectElement).value).toBe("default");
    expect(within(dialog()).getAllByText("Default (on)")).toHaveLength(2);
  });

  it("saves the choice for this conversation only, and Default takes it away", () => {
    render(<NotificationBell target={conversation} />);
    open();
    fireEvent.change(within(dialog()).getByLabelText("Sound"), { target: { value: "off" } });
    expect(h.update).toHaveBeenLastCalledWith({ type: "CONVERSATION", id: "c1", sound: false });
    fireEvent.change(within(dialog()).getByLabelText("System notification"), { target: { value: "on" } });
    expect(h.update).toHaveBeenLastCalledWith({ type: "CONVERSATION", id: "c1", notify: true });
    fireEvent.change(within(dialog()).getByLabelText("Sound"), { target: { value: "default" } });
    expect(h.update).toHaveBeenLastCalledWith({ type: "CONVERSATION", id: "c1", sound: null });
  });

  it("shows what is chosen, and what Default means: the global choice", () => {
    h.prefs = indexPrefs([
      { type: "GLOBAL", id: null, sound: false, notify: null },
      { type: "CONVERSATION", id: "c1", sound: null, notify: false },
    ]);
    render(<NotificationBell target={conversation} />);
    open();
    expect((within(dialog()).getByLabelText("Sound") as HTMLSelectElement).value).toBe("default");
    expect(within(dialog()).getByText("Default (off)")).not.toBeNull();
    expect((within(dialog()).getByLabelText("System notification") as HTMLSelectElement).value).toBe("off");
    expect(within(dialog()).getByText("Sound: off. Notifications: off.")).not.toBeNull();
  });
});

describe("a channel's notification settings", () => {
  it("has a choice for the channel and, separately, one for the whole community", () => {
    render(<NotificationBell target={channel} />);
    open();
    expect(within(dialog()).getByRole("heading", { name: "This channel" })).not.toBeNull();
    expect(within(dialog()).getByRole("heading", { name: "All of Club" })).not.toBeNull();
    expect(within(dialog()).getAllByLabelText("Sound")).toHaveLength(2);
    expect(within(dialog()).getAllByLabelText("System notification")).toHaveLength(2);
  });

  it("saves the channel's choice for the channel and the community's for the community", () => {
    render(<NotificationBell target={channel} />);
    open();
    const sounds = within(dialog()).getAllByLabelText("Sound");
    fireEvent.change(sounds[0], { target: { value: "off" } });
    expect(h.update).toHaveBeenLastCalledWith({ type: "CHANNEL", id: "ch1", sound: false });
    fireEvent.change(sounds[1], { target: { value: "off" } });
    expect(h.update).toHaveBeenLastCalledWith({ type: "COMMUNITY", id: "co1", sound: false });
    const notifies = within(dialog()).getAllByLabelText("System notification");
    fireEvent.change(notifies[0], { target: { value: "on" } });
    expect(h.update).toHaveBeenLastCalledWith({ type: "CHANNEL", id: "ch1", notify: true });
    fireEvent.change(notifies[1], { target: { value: "on" } });
    expect(h.update).toHaveBeenLastCalledWith({ type: "COMMUNITY", id: "co1", notify: true });
  });

  it("says a channel's Default is what its community says, and the community's is the global choice", () => {
    h.prefs = indexPrefs([
      { type: "GLOBAL", id: null, sound: true, notify: true },
      { type: "COMMUNITY", id: "co1", sound: false, notify: null },
    ]);
    render(<NotificationBell target={channel} />);
    open();
    const sounds = within(dialog()).getAllByLabelText("Sound") as HTMLSelectElement[];
    // The channel follows the community (off); the community follows the global choice (on).
    expect(sounds[0].selectedOptions[0].textContent).toBe("Default (off)");
    expect(sounds[1].value).toBe("off");
    expect(sounds[1].selectedOptions[0].textContent).toBe("Off");
    const notifies = within(dialog()).getAllByLabelText("System notification") as HTMLSelectElement[];
    expect(notifies[0].selectedOptions[0].textContent).toBe("Default (on)");
  });

  it("states the result for the channel in words", () => {
    h.prefs = indexPrefs([
      { type: "COMMUNITY", id: "co1", sound: false, notify: false },
      { type: "CHANNEL", id: "ch1", sound: true, notify: null },
    ]);
    render(<NotificationBell target={channel} />);
    open();
    expect(within(dialog()).getByText("Sound: on. Notifications: off.")).not.toBeNull();
  });
});
