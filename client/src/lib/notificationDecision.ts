import type { Message } from "../api";
import { isEnabled, type PrefsIndex, type Place } from "./notificationPrefs";

// Whether an arriving message makes a sound and shows a system notification. Pure: what is open, whether the app has focus and
// what the person chose are all handed in, so the rules can be tested without a browser.

export interface ActiveChat {
  /** The conversation or channel on screen. */
  place: Place;
}

export interface AlertContext {
  message: Pick<Message, "sender" | "deletedAt">;
  /** The signed-in person's id (a message you sent yourself, from another device, never alerts). */
  selfId: string;
  /** The person's own presence: Do not disturb silences everything. */
  selfStatus: string | undefined;
  place: Place;
  /** The conversation or channel the person is looking at, if any. */
  active: Place | null;
  /** Whether the app's window or tab is in front and has focus. */
  focused: boolean;
  prefs: PrefsIndex;
}

export interface AlertDecision {
  sound: boolean;
  notify: boolean;
}

const NONE: AlertDecision = { sound: false, notify: false };

/** The same place: the same conversation, or the same channel. */
export function samePlace(a: Place | null, b: Place): boolean {
  if (!a) return false;
  if ("conversationId" in a && "conversationId" in b) return a.conversationId === b.conversationId;
  if ("channelId" in a && "channelId" in b) return a.channelId === b.channelId;
  return false;
}

/**
 * - never for your own messages (sent from another device of yours) or one that is already deleted;
 * - never while your status is Do not disturb;
 * - never for the conversation or channel you have OPEN while the app has focus (you are reading it): but still for it when the
 *   app is in the background or another window has focus, and still for every OTHER conversation and channel;
 * - otherwise each of the sound and the notification follows the person's choices for that place (the most specific wins), on unless chosen otherwise.
 */
export function decideAlert(context: AlertContext): AlertDecision {
  if (context.message.deletedAt) return NONE;
  if (context.message.sender.id === context.selfId) return NONE;
  if (context.selfStatus === "DO_NOT_DISTURB") return NONE;
  if (context.focused && samePlace(context.active, context.place)) return NONE;
  return { sound: isEnabled(context.prefs, "sound", context.place), notify: isEnabled(context.prefs, "notify", context.place) };
}
