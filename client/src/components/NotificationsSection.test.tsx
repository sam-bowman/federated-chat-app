import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Community, Conversation } from "../api";
import { emptyPrefs, indexPrefs, type PrefsIndex } from "../lib/notificationPrefs";

const h = vi.hoisted(() => ({
  prefs: null as unknown,
  update: vi.fn(),
  communities: [] as unknown[],
  conversations: [] as unknown[],
  permission: "default" as string,
  requestPermission: vi.fn(),
  showNotification: vi.fn(),
  playSound: vi.fn(),
}));

vi.mock("../context/NotificationSettingsContext", () => ({ useNotificationSettings: () => ({ prefs: h.prefs, update: h.update }) }));
vi.mock("../context/AppDataContext", () => ({ useOptionalAppData: () => ({ communities: h.communities, conversations: h.conversations }) }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: { id: "me" } }) }));
vi.mock("../lib/systemNotification", () => ({
  notificationPermission: async () => h.permission,
  requestNotificationPermission: (...a: unknown[]) => h.requestPermission(...a),
  showSystemNotification: (...a: unknown[]) => h.showNotification(...a),
}));
vi.mock("../lib/notificationSound", () => ({ unlockAudio: () => {}, playNotificationSound: (...a: unknown[]) => h.playSound(...a) }));

import NotificationsSection from "./NotificationsSection";

const community = { id: "co1", name: "Club", channels: [{ id: "ch1", name: "general" }] } as unknown as Community;
const dm = { id: "c1", type: "DM", title: null, members: [{ id: "me", displayName: "Me" }, { id: "u2", displayName: "Alice" }] } as unknown as Conversation;

beforeEach(() => {
  h.prefs = emptyPrefs();
  h.update.mockReset().mockResolvedValue(undefined);
  h.communities = [community];
  h.conversations = [dm];
  h.permission = "default";
  h.requestPermission.mockReset().mockResolvedValue("granted");
  h.showNotification.mockReset().mockResolvedValue(true);
  h.playSound.mockReset().mockResolvedValue(true);
});

afterEach(cleanup);

describe("Settings -> Notifications", () => {
  it("has both on by default, and changing one sends just that one", () => {
    render(<NotificationsSection />);
    const sound = screen.getByRole("checkbox", { name: "Play a sound when a message arrives" }) as HTMLInputElement;
    const notify = screen.getByRole("checkbox", { name: "Show a system notification when a message arrives" }) as HTMLInputElement;
    expect(sound.checked).toBe(true);
    expect(notify.checked).toBe(true);

    fireEvent.click(sound);
    expect(h.update).toHaveBeenLastCalledWith({ type: "GLOBAL", sound: false });
    fireEvent.click(notify);
    expect(h.update).toHaveBeenLastCalledWith({ type: "GLOBAL", notify: false });
  });

  it("shows what was chosen", () => {
    h.prefs = indexPrefs([{ type: "GLOBAL", id: null, sound: false, notify: null }]);
    render(<NotificationsSection />);
    expect((screen.getByRole("checkbox", { name: "Play a sound when a message arrives" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Show a system notification when a message arrives" }) as HTMLInputElement).checked).toBe(true);
  });

  it("explains the open-chat and Do not disturb rules", () => {
    render(<NotificationsSection />);
    expect(screen.getByText(/open while the app has focus/)).not.toBeNull();
    expect(screen.getByText(/Do not disturb/)).not.toBeNull();
  });

  describe("the permission to show system notifications", () => {
    it("offers to allow them when they are not allowed yet, and says so once they are", async () => {
      render(<NotificationsSection />);
      await screen.findByText("System notifications are not allowed on this device yet.");

      fireEvent.click(screen.getByRole("button", { name: "Allow system notifications" }));

      await screen.findByText("System notifications are allowed on this device.");
      expect(h.requestPermission).toHaveBeenCalledOnce();
      expect(screen.queryByRole("button", { name: "Allow system notifications" })).toBeNull();
    });

    it("says when they were blocked, with no button that cannot work", async () => {
      h.permission = "denied";
      render(<NotificationsSection />);
      await screen.findByText(/blocked on this device/);
      expect(screen.queryByRole("button", { name: "Allow system notifications" })).toBeNull();
    });

    it("says when the browser cannot show them", async () => {
      h.permission = "unsupported";
      render(<NotificationsSection />);
      await screen.findByText("This browser cannot show system notifications.");
    });

    it("shows nothing about it for an already allowed device except that it is allowed", async () => {
      h.permission = "granted";
      render(<NotificationsSection />);
      await screen.findByText("System notifications are allowed on this device.");
      expect(screen.queryByRole("button", { name: "Allow system notifications" })).toBeNull();
    });
  });

  describe("the test buttons", () => {
    it("plays the sound even right after another, and says so", async () => {
      render(<NotificationsSection />);
      fireEvent.click(screen.getByRole("button", { name: "Play test sound" }));
      await screen.findByText("Played.");
      expect(h.playSound).toHaveBeenCalledWith({ force: true });
    });

    it("says when the browser has not allowed sound yet", async () => {
      h.playSound.mockResolvedValue(false);
      render(<NotificationsSection />);
      fireEvent.click(screen.getByRole("button", { name: "Play test sound" }));
      await screen.findByText(/has not allowed sound yet/);
    });

    it("shows a test notification when allowed", async () => {
      h.permission = "granted";
      render(<NotificationsSection />);
      await screen.findByText("System notifications are allowed on this device.");
      fireEvent.click(screen.getByRole("button", { name: "Show test notification" }));
      await screen.findByText("Sent.");
      expect(h.requestPermission).not.toHaveBeenCalled();
      expect(h.showNotification.mock.calls[0][0]).toMatchObject({ title: "Notifications are on", tag: "test" });
    });

    it("asks for the permission first, from the click, when it has not been given", async () => {
      render(<NotificationsSection />);
      await screen.findByText(/not allowed on this device yet/);
      fireEvent.click(screen.getByRole("button", { name: "Show test notification" }));
      await screen.findByText("Sent.");
      expect(h.requestPermission).toHaveBeenCalledOnce();
    });

    it("says it was blocked when the person refuses", async () => {
      h.requestPermission.mockResolvedValue("denied");
      render(<NotificationsSection />);
      await screen.findByText(/not allowed on this device yet/);
      fireEvent.click(screen.getByRole("button", { name: "Show test notification" }));
      await waitFor(() => expect(screen.getByText(/Notifications are blocked/)).not.toBeNull());
      expect(h.showNotification).not.toHaveBeenCalled();
    });
  });

  describe("places with their own choice", () => {
    it("says there are none, and where to make one", () => {
      render(<NotificationsSection />);
      expect(screen.getByText(/None\. Use the bell/)).not.toBeNull();
    });

    it("lists each one by name with what it is set to, and puts it back to the default on Reset", () => {
      h.prefs = indexPrefs([
        { type: "COMMUNITY", id: "co1", sound: false, notify: null },
        { type: "CHANNEL", id: "ch1", sound: null, notify: false },
        { type: "CONVERSATION", id: "c1", sound: true, notify: true },
      ]);
      render(<NotificationsSection />);

      expect(screen.getByText("Club (all of it)")).not.toBeNull();
      expect(screen.getByText("#general in Club")).not.toBeNull();
      expect(screen.getByText("Alice")).not.toBeNull();
      expect(screen.getByText("Sound off · Notifications default")).not.toBeNull();
      expect(screen.getByText("Sound default · Notifications off")).not.toBeNull();
      expect(screen.getByText("Sound on · Notifications on")).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Put #general in Club back to the default" }));
      expect(h.update).toHaveBeenLastCalledWith({ type: "CHANNEL", id: "ch1", sound: null, notify: null });
      fireEvent.click(screen.getByRole("button", { name: "Put Club (all of it) back to the default" }));
      expect(h.update).toHaveBeenLastCalledWith({ type: "COMMUNITY", id: "co1", sound: null, notify: null });
      fireEvent.click(screen.getByRole("button", { name: "Put Alice back to the default" }));
      expect(h.update).toHaveBeenLastCalledWith({ type: "CONVERSATION", id: "c1", sound: null, notify: null });
    });

    it("can still reset one for something that is gone", () => {
      h.prefs = indexPrefs([{ type: "CHANNEL", id: "deleted", sound: false, notify: null }]) satisfies PrefsIndex;
      render(<NotificationsSection />);
      fireEvent.click(screen.getByRole("button", { name: "Put A channel that is no longer there back to the default" }));
      expect(h.update).toHaveBeenCalledWith({ type: "CHANNEL", id: "deleted", sound: null, notify: null });
    });

    it("names a group chat by its title", () => {
      h.conversations = [{ id: "g1", type: "GROUP", title: "Weekend plans", members: [] }];
      h.prefs = indexPrefs([{ type: "CONVERSATION", id: "g1", sound: false, notify: null }]);
      render(<NotificationsSection />);
      expect(screen.getByText("Weekend plans")).not.toBeNull();
    });
  });
});
