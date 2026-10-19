import { describe, expect, it } from "vitest";
import type { NotificationSetting } from "../api";
import { emptyPrefs, indexPrefs, isEnabled, ownChoice, withChange, withSetting } from "./notificationPrefs";

const setting = (type: NotificationSetting["type"], id: string | null, sound: boolean | null, notify: boolean | null): NotificationSetting => ({ type, id, sound, notify });

describe("isEnabled: the most specific choice wins", () => {
  it("is on for both when nothing has been chosen anywhere", () => {
    const prefs = emptyPrefs();
    for (const kind of ["sound", "notify"] as const) {
      expect(isEnabled(prefs, kind, { conversationId: "c1" })).toBe(true);
      expect(isEnabled(prefs, kind, { channelId: "ch1", communityId: "co1" })).toBe(true);
      expect(isEnabled(prefs, kind, { channelId: "ch1" })).toBe(true);
    }
  });

  it("follows the global choice where a place has none", () => {
    const prefs = indexPrefs([setting("GLOBAL", null, false, null)]);
    expect(isEnabled(prefs, "sound", { conversationId: "c1" })).toBe(false);
    expect(isEnabled(prefs, "sound", { channelId: "ch1", communityId: "co1" })).toBe(false);
    // Only the sound was chosen: the notification is still on.
    expect(isEnabled(prefs, "notify", { conversationId: "c1" })).toBe(true);
  });

  it("lets a conversation's own choice beat the global one, in both directions", () => {
    const off = indexPrefs([setting("GLOBAL", null, true, true), setting("CONVERSATION", "c1", false, false)]);
    expect(isEnabled(off, "sound", { conversationId: "c1" })).toBe(false);
    expect(isEnabled(off, "notify", { conversationId: "c1" })).toBe(false);
    expect(isEnabled(off, "sound", { conversationId: "c2" })).toBe(true);

    const on = indexPrefs([setting("GLOBAL", null, false, false), setting("CONVERSATION", "c1", true, true)]);
    expect(isEnabled(on, "sound", { conversationId: "c1" })).toBe(true);
    expect(isEnabled(on, "sound", { conversationId: "c2" })).toBe(false);
  });

  it("makes a channel follow its community, and the community follow the global choice", () => {
    const prefs = indexPrefs([setting("COMMUNITY", "co1", false, null)]);
    expect(isEnabled(prefs, "sound", { channelId: "ch1", communityId: "co1" })).toBe(false);
    expect(isEnabled(prefs, "sound", { channelId: "ch1", communityId: "co2" })).toBe(true);
    expect(isEnabled(prefs, "notify", { channelId: "ch1", communityId: "co1" })).toBe(true);
  });

  it("lets a channel's own choice beat its community's, and the community's beat the global", () => {
    const prefs = indexPrefs([
      setting("GLOBAL", null, true, true),
      setting("COMMUNITY", "co1", false, false),
      setting("CHANNEL", "ch1", true, null),
    ]);
    expect(isEnabled(prefs, "sound", { channelId: "ch1", communityId: "co1" })).toBe(true); // the channel
    expect(isEnabled(prefs, "notify", { channelId: "ch1", communityId: "co1" })).toBe(false); // no channel choice: the community's
    expect(isEnabled(prefs, "sound", { channelId: "ch2", communityId: "co1" })).toBe(false); // another channel: the community's
    expect(isEnabled(prefs, "sound", { channelId: "ch2", communityId: "co9" })).toBe(true); // another community: the global
  });

  it("does not mix up a channel and a conversation that share an id, or a choice for sound with one for notify", () => {
    const prefs = indexPrefs([setting("CHANNEL", "same", false, null), setting("CONVERSATION", "same", null, false)]);
    expect(isEnabled(prefs, "sound", { channelId: "same" })).toBe(false);
    expect(isEnabled(prefs, "notify", { channelId: "same" })).toBe(true);
    expect(isEnabled(prefs, "sound", { conversationId: "same" })).toBe(true);
    expect(isEnabled(prefs, "notify", { conversationId: "same" })).toBe(false);
  });

  it("ignores a community choice when the channel's community is not known", () => {
    const prefs = indexPrefs([setting("COMMUNITY", "co1", false, false)]);
    expect(isEnabled(prefs, "sound", { channelId: "ch1" })).toBe(true);
  });
});

describe("the index", () => {
  it("ignores a place with no id and keeps a missing choice as no choice", () => {
    const prefs = indexPrefs([setting("CHANNEL", null, false, false), { type: "CHANNEL", id: "ch1", sound: undefined as unknown as null, notify: false }]);
    expect(prefs.channels.size).toBe(1);
    expect(prefs.channels.get("ch1")).toEqual({ sound: null, notify: false });
  });

  it("puts one setting in and takes it out again when no choice is left", () => {
    let prefs = withSetting(emptyPrefs(), setting("CHANNEL", "ch1", false, null));
    expect(prefs.channels.get("ch1")).toEqual({ sound: false, notify: null });
    prefs = withSetting(prefs, setting("CHANNEL", "ch1", null, null));
    expect(prefs.channels.has("ch1")).toBe(false);
  });

  it("does not change the index it was given", () => {
    const before = indexPrefs([setting("CHANNEL", "ch1", false, null)]);
    const after = withSetting(before, setting("CHANNEL", "ch2", true, null));
    expect(before.channels.has("ch2")).toBe(false);
    expect(after.channels.has("ch2")).toBe(true);
  });

  it("applies a change the way the server will: the choices named replace the old, the rest stay", () => {
    let prefs = indexPrefs([setting("COMMUNITY", "co1", false, true)]);
    prefs = withChange(prefs, { type: "COMMUNITY", id: "co1", notify: false });
    expect(prefs.communities.get("co1")).toEqual({ sound: false, notify: false });
    prefs = withChange(prefs, { type: "COMMUNITY", id: "co1", sound: null });
    expect(prefs.communities.get("co1")).toEqual({ sound: null, notify: false });
    prefs = withChange(prefs, { type: "COMMUNITY", id: "co1", notify: null });
    expect(prefs.communities.has("co1")).toBe(false);
    prefs = withChange(prefs, { type: "GLOBAL", sound: false });
    expect(prefs.global).toEqual({ sound: false, notify: null });
  });

  it("says whether a place has a choice of its own", () => {
    const prefs = indexPrefs([setting("CHANNEL", "ch1", false, null)]);
    expect(ownChoice(prefs, "sound", { type: "CHANNEL", id: "ch1" })).toBe(false);
    expect(ownChoice(prefs, "notify", { type: "CHANNEL", id: "ch1" })).toBeNull();
    expect(ownChoice(prefs, "sound", { type: "CONVERSATION", id: "ch1" })).toBeNull();
  });
});
