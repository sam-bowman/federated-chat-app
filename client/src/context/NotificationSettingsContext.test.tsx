import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationSetting } from "../api";

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (payload: unknown) => void>,
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../api", () => ({ getNotificationSettings: h.get, setNotificationSetting: h.set }));
vi.mock("./WsContext", () => ({
  useWs: () => ({
    subscribe: (type: string, handler: (payload: unknown) => void) => {
      h.handlers[type] = handler;
      return () => delete h.handlers[type];
    },
  }),
}));

import { isEnabled } from "../lib/notificationPrefs";
import { NotificationSettingsProvider, useNotificationSettings } from "./NotificationSettingsContext";

const wrapper = ({ children }: { children: ReactNode }) => <NotificationSettingsProvider>{children}</NotificationSettingsProvider>;
const setting = (type: NotificationSetting["type"], id: string | null, sound: boolean | null, notify: boolean | null): NotificationSetting => ({ type, id, sound, notify });

beforeEach(() => {
  h.handlers = {};
  h.get.mockReset().mockResolvedValue([]);
  h.set.mockReset();
});

afterEach(cleanup);

describe("NotificationSettingsProvider", () => {
  it("starts with everything on, then takes what the server has", async () => {
    h.get.mockResolvedValue([setting("GLOBAL", null, false, null), setting("CHANNEL", "ch1", true, null)]);
    const { result } = renderHook(() => useNotificationSettings(), { wrapper });
    expect(result.current.loaded).toBe(false);
    expect(isEnabled(result.current.prefs, "sound", { channelId: "ch2" })).toBe(true);

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(isEnabled(result.current.prefs, "sound", { channelId: "ch2" })).toBe(false);
    expect(isEnabled(result.current.prefs, "sound", { channelId: "ch1" })).toBe(true);
  });

  it("keeps everything on if the server cannot be reached", async () => {
    h.get.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useNotificationSettings(), { wrapper });
    await act(async () => {});
    expect(result.current.loaded).toBe(false);
    expect(isEnabled(result.current.prefs, "sound", { conversationId: "c1" })).toBe(true);
  });

  it("shows a change at once, then takes the server's answer", async () => {
    let answer!: (value: unknown) => void;
    h.set.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useNotificationSettings(), { wrapper });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let done!: Promise<void>;
    act(() => {
      done = result.current.update({ type: "CONVERSATION", id: "c1", sound: false });
    });
    // Before the server has answered.
    expect(isEnabled(result.current.prefs, "sound", { conversationId: "c1" })).toBe(false);
    expect(h.set).toHaveBeenCalledWith({ type: "CONVERSATION", id: "c1", sound: false });

    await act(async () => {
      answer({ setting: setting("CONVERSATION", "c1", false, null), settings: [] });
      await done;
    });
    expect(isEnabled(result.current.prefs, "sound", { conversationId: "c1" })).toBe(false);
  });

  it("puts the choices back as the server has them if a change fails", async () => {
    const { result } = renderHook(() => useNotificationSettings(), { wrapper });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    h.set.mockRejectedValue(new Error("refused"));
    h.get.mockResolvedValue([]);

    await act(async () => {
      await result.current.update({ type: "GLOBAL", sound: false });
    });

    expect(h.get).toHaveBeenCalledTimes(2);
    expect(isEnabled(result.current.prefs, "sound", { conversationId: "c1" })).toBe(true);
  });

  it("takes a change made on another device as it is made", async () => {
    const { result } = renderHook(() => useNotificationSettings(), { wrapper });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => h.handlers["notification-settings:updated"]({ setting: setting("COMMUNITY", "co1", false, false) }));
    expect(isEnabled(result.current.prefs, "notify", { channelId: "ch1", communityId: "co1" })).toBe(false);

    act(() => h.handlers["notification-settings:updated"]({ setting: setting("COMMUNITY", "co1", null, null) }));
    expect(isEnabled(result.current.prefs, "notify", { channelId: "ch1", communityId: "co1" })).toBe(true);
  });

  it("reads everything again for an event that carries no setting", async () => {
    const { result } = renderHook(() => useNotificationSettings(), { wrapper });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    h.get.mockResolvedValue([setting("GLOBAL", null, false, null)]);

    await act(async () => h.handlers["notification-settings:updated"]({}));

    await waitFor(() => expect(isEnabled(result.current.prefs, "sound", { conversationId: "c1" })).toBe(false));
  });
});

describe("useNotificationSettings without a provider", () => {
  it("has everything on and changes nothing, so a page rendered on its own needs none", async () => {
    function Probe() {
      const { prefs, update, loaded } = useNotificationSettings();
      return <span data-testid="p">{String(isEnabled(prefs, "sound", { conversationId: "c" }))}{String(loaded)}{String(typeof update)}</span>;
    }
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("p").textContent).toBe("truefalsefunction");
  });
});
