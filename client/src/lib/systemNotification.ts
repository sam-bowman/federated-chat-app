import { isDesktopApp } from "./appearance";

// System notifications (the box that appears in the corner of the screen). In the desktop app they go through Tauri's
// notification plugin; in a browser, through the web Notification API, which only works after the person has agreed (and the
// browser only lets the page ask in response to a click: see `requestNotificationPermission`).

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

export interface SystemNotification {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other (a burst from one conversation is one box, not ten). */
  tag: string;
  /** Called when the person clicks it (web only). */
  onClick?: () => void;
}

function webSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function notificationPermission(): Promise<NotificationPermissionState> {
  if (isDesktopApp()) {
    try {
      const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
      return (await isPermissionGranted()) ? "granted" : "default";
    } catch {
      return "unsupported";
    }
  }
  if (!webSupported()) return "unsupported";
  return Notification.permission;
}

/** Asks the person to allow notifications. Call it from a click: a browser ignores or blocks it otherwise. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (isDesktopApp()) {
    try {
      const { requestPermission } = await import("@tauri-apps/plugin-notification");
      return (await requestPermission()) === "granted" ? "granted" : "denied";
    } catch {
      return "unsupported";
    }
  }
  if (!webSupported()) return "unsupported";
  return Notification.requestPermission();
}

/** Shows one if the person has allowed it. Resolves true if it was shown. A failure is not an error: it is just not shown. */
export async function showSystemNotification(notification: SystemNotification): Promise<boolean> {
  try {
    if (isDesktopApp()) {
      const { isPermissionGranted, sendNotification } = await import("@tauri-apps/plugin-notification");
      if (!(await isPermissionGranted())) return false;
      sendNotification({ title: notification.title, body: notification.body });
      return true;
    }
    if (!webSupported() || Notification.permission !== "granted") return false;
    const shown = new Notification(notification.title, { body: notification.body, tag: notification.tag, silent: true });
    if (notification.onClick) {
      shown.onclick = () => {
        shown.close();
        notification.onClick?.();
      };
    }
    return true;
  } catch {
    return false;
  }
}
