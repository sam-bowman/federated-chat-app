import { useEffect } from "react";
import type { Place } from "./notificationPrefs";

// The conversation or channel on screen, so a message for it does not make a sound or a notification while you are looking at it.
// The page that shows one says so (`useReportActiveChat`) and says nothing when it goes away.

let active: Place | null = null;

export function getActiveChat(): Place | null {
  return active;
}

export function setActiveChat(place: Place | null): void {
  active = place;
}

/** Tells the notifier which conversation or channel this page is showing, for as long as it is. */
export function useReportActiveChat(place: Place | null): void {
  const key = place === null ? null : "conversationId" in place ? `c:${place.conversationId}` : `h:${place.channelId}`;
  useEffect(() => {
    setActiveChat(place);
    return () => {
      // Only clear what is still ours: the next page may already have said where it is.
      if (active === place) setActiveChat(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Whether the app is in front and has focus: the window the person is using, not a tab or window behind another. */
export function isAppFocused(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}
