import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => plugin);

import { notificationPermission, requestNotificationPermission, showSystemNotification } from "./systemNotification";

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestResult: NotificationPermission = "granted";
  static created: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => FakeNotification.requestResult);
  onclick: (() => void) | null = null;
  close = vi.fn();
  title: string;
  options: NotificationOptions;
  constructor(title: string, options: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotification.created.push(this);
  }
}

const win = window as unknown as { Notification?: unknown; __TAURI_INTERNALS__?: object };

beforeEach(() => {
  FakeNotification.permission = "granted";
  FakeNotification.requestResult = "granted";
  FakeNotification.created = [];
  FakeNotification.requestPermission.mockClear();
  win.Notification = FakeNotification;
  delete win.__TAURI_INTERNALS__;
  Object.values(plugin).forEach((f) => f.mockReset());
});

afterEach(() => {
  delete win.Notification;
  delete win.__TAURI_INTERNALS__;
});

const sample = { title: "Alice in #general (Club)", body: "hello", tag: "h:ch1" };

describe("in a browser", () => {
  it("shows one when the person has allowed it, quietly because the sound is a separate choice", async () => {
    expect(await showSystemNotification(sample)).toBe(true);
    expect(FakeNotification.created).toHaveLength(1);
    expect(FakeNotification.created[0].title).toBe("Alice in #general (Club)");
    expect(FakeNotification.created[0].options).toMatchObject({ body: "hello", tag: "h:ch1", silent: true });
  });

  it("shows nothing when it has not been allowed, or was blocked", async () => {
    FakeNotification.permission = "default";
    expect(await showSystemNotification(sample)).toBe(false);
    FakeNotification.permission = "denied";
    expect(await showSystemNotification(sample)).toBe(false);
    expect(FakeNotification.created).toHaveLength(0);
  });

  it("runs the click handler and closes the box when it is clicked", async () => {
    const onClick = vi.fn();
    await showSystemNotification({ ...sample, onClick });
    const shown = FakeNotification.created[0];
    shown.onclick?.();
    expect(shown.close).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is not an error if the browser refuses to make one", async () => {
    win.Notification = class {
      static permission = "granted";
      constructor() {
        throw new Error("illegal constructor");
      }
    };
    expect(await showSystemNotification(sample)).toBe(false);
  });

  it("reads and asks for the permission", async () => {
    FakeNotification.permission = "default";
    expect(await notificationPermission()).toBe("default");
    FakeNotification.requestResult = "denied";
    expect(await requestNotificationPermission()).toBe("denied");
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("says unsupported where there is no Notification API, and shows nothing", async () => {
    delete win.Notification;
    expect(await notificationPermission()).toBe("unsupported");
    expect(await requestNotificationPermission()).toBe("unsupported");
    expect(await showSystemNotification(sample)).toBe(false);
  });
});

describe("in the desktop app", () => {
  beforeEach(() => {
    win.__TAURI_INTERNALS__ = {};
  });

  it("sends it through the notification plugin when it is allowed, and not through the web API", async () => {
    plugin.isPermissionGranted.mockResolvedValue(true);
    expect(await showSystemNotification(sample)).toBe(true);
    expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "Alice in #general (Club)", body: "hello" });
    expect(FakeNotification.created).toHaveLength(0);
  });

  it("sends nothing when the system has not allowed it", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    expect(await showSystemNotification(sample)).toBe(false);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("is not an error if the plugin fails", async () => {
    plugin.isPermissionGranted.mockRejectedValue(new Error("no plugin"));
    plugin.requestPermission.mockRejectedValue(new Error("no plugin"));
    expect(await showSystemNotification(sample)).toBe(false);
    expect(await notificationPermission()).toBe("unsupported");
    expect(await requestNotificationPermission()).toBe("unsupported");
  });

  it("reads and asks for the permission through the plugin", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    expect(await notificationPermission()).toBe("default");
    plugin.isPermissionGranted.mockResolvedValue(true);
    expect(await notificationPermission()).toBe("granted");
    plugin.requestPermission.mockResolvedValue("denied");
    expect(await requestNotificationPermission()).toBe("denied");
    plugin.requestPermission.mockResolvedValue("granted");
    expect(await requestNotificationPermission()).toBe("granted");
  });
});
