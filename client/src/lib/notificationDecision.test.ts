import { describe, expect, it } from "vitest";
import type { PublicUser } from "../api";
import { decideAlert, samePlace, type AlertContext } from "./notificationDecision";
import { emptyPrefs, indexPrefs } from "./notificationPrefs";

const person = (id: string) => ({ id }) as PublicUser;

function context(overrides: Partial<AlertContext> = {}): AlertContext {
  return {
    message: { sender: person("them"), deletedAt: null },
    selfId: "me",
    selfStatus: "ONLINE",
    place: { conversationId: "c1" },
    active: null,
    focused: true,
    prefs: emptyPrefs(),
    ...overrides,
  };
}

describe("decideAlert: when a message makes a sound and a notification", () => {
  it("does both for a message from someone else, with nothing chosen", () => {
    expect(decideAlert(context())).toEqual({ sound: true, notify: true });
  });

  it("does neither for your own message (from another device of yours)", () => {
    expect(decideAlert(context({ message: { sender: person("me"), deletedAt: null } }))).toEqual({ sound: false, notify: false });
  });

  it("does neither for a message that is already deleted", () => {
    expect(decideAlert(context({ message: { sender: person("them"), deletedAt: "2026-01-01T00:00:00Z" } }))).toEqual({ sound: false, notify: false });
  });

  it("does neither while your status is Do not disturb, but does for Busy and Away", () => {
    expect(decideAlert(context({ selfStatus: "DO_NOT_DISTURB" }))).toEqual({ sound: false, notify: false });
    for (const status of ["BUSY", "AWAY", "ONLINE", "INVISIBLE", undefined]) {
      expect(decideAlert(context({ selfStatus: status })), String(status)).toEqual({ sound: true, notify: true });
    }
  });

  describe("the conversation or channel that is open", () => {
    it("does neither while the app has focus", () => {
      expect(decideAlert(context({ active: { conversationId: "c1" }, focused: true }))).toEqual({ sound: false, notify: false });
      expect(decideAlert(context({ place: { channelId: "ch1", communityId: "co1" }, active: { channelId: "ch1", communityId: "co1" } }))).toEqual({ sound: false, notify: false });
    });

    it("does both when the app is in the background or another window has focus", () => {
      expect(decideAlert(context({ active: { conversationId: "c1" }, focused: false }))).toEqual({ sound: true, notify: true });
      expect(decideAlert(context({ place: { channelId: "ch1" }, active: { channelId: "ch1" }, focused: false }))).toEqual({ sound: true, notify: true });
    });

    it("still does both for ANOTHER conversation or channel while the app has focus", () => {
      expect(decideAlert(context({ place: { conversationId: "c2" }, active: { conversationId: "c1" }, focused: true }))).toEqual({ sound: true, notify: true });
      expect(decideAlert(context({ place: { channelId: "ch2" }, active: { channelId: "ch1" }, focused: true }))).toEqual({ sound: true, notify: true });
    });

    it("does not take a conversation and a channel with the same id for the same place", () => {
      expect(decideAlert(context({ place: { channelId: "x" }, active: { conversationId: "x" }, focused: true }))).toEqual({ sound: true, notify: true });
      expect(decideAlert(context({ place: { conversationId: "x" }, active: { channelId: "x" }, focused: true }))).toEqual({ sound: true, notify: true });
    });

    it("does both when nothing is open (for example on the friends page)", () => {
      expect(decideAlert(context({ active: null, focused: true }))).toEqual({ sound: true, notify: true });
    });
  });

  describe("what the person chose", () => {
    it("takes the sound and the notification separately", () => {
      const prefs = indexPrefs([{ type: "CONVERSATION", id: "c1", sound: false, notify: null }]);
      expect(decideAlert(context({ prefs }))).toEqual({ sound: false, notify: true });
      const other = indexPrefs([{ type: "CONVERSATION", id: "c1", sound: null, notify: false }]);
      expect(decideAlert(context({ prefs: other }))).toEqual({ sound: true, notify: false });
    });

    it("does neither for a muted place, and both again for a place that has its own on within a muted community", () => {
      const prefs = indexPrefs([
        { type: "COMMUNITY", id: "co1", sound: false, notify: false },
        { type: "CHANNEL", id: "loud", sound: true, notify: true },
      ]);
      expect(decideAlert(context({ prefs, place: { channelId: "quiet", communityId: "co1" } }))).toEqual({ sound: false, notify: false });
      expect(decideAlert(context({ prefs, place: { channelId: "loud", communityId: "co1" } }))).toEqual({ sound: true, notify: true });
    });

    it("applies the global choice everywhere that has none of its own", () => {
      const prefs = indexPrefs([{ type: "GLOBAL", id: null, sound: false, notify: false }]);
      expect(decideAlert(context({ prefs }))).toEqual({ sound: false, notify: false });
      expect(decideAlert(context({ prefs, place: { channelId: "ch9", communityId: "co9" } }))).toEqual({ sound: false, notify: false });
    });

    it("never alerts for the open place even if the person turned everything on for it", () => {
      const prefs = indexPrefs([{ type: "CONVERSATION", id: "c1", sound: true, notify: true }]);
      expect(decideAlert(context({ prefs, active: { conversationId: "c1" }, focused: true }))).toEqual({ sound: false, notify: false });
    });
  });
});

describe("samePlace", () => {
  it("compares kind and id", () => {
    expect(samePlace(null, { conversationId: "a" })).toBe(false);
    expect(samePlace({ conversationId: "a" }, { conversationId: "a" })).toBe(true);
    expect(samePlace({ conversationId: "a" }, { conversationId: "b" })).toBe(false);
    expect(samePlace({ channelId: "a" }, { channelId: "a", communityId: "x" })).toBe(true);
    expect(samePlace({ channelId: "a" }, { conversationId: "a" })).toBe(false);
  });
});
