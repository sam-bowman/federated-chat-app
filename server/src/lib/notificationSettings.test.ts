import { describe, expect, it } from "vitest";
import { MAX_SETTINGS_PER_USER, applyChange, serializeSetting, settingChangeSchema } from "./notificationSettings.js";

const ok = (value: unknown) => settingChangeSchema.safeParse(value).success;

describe("settingChangeSchema", () => {
  it("takes the global setting with no id, and a place with one", () => {
    expect(ok({ type: "GLOBAL", sound: false })).toBe(true);
    expect(ok({ type: "COMMUNITY", id: "01HZ0000000000000000000000", notify: true })).toBe(true);
    expect(ok({ type: "CHANNEL", id: "c-1_x", sound: null, notify: false })).toBe(true);
    expect(ok({ type: "CONVERSATION", id: "abc", sound: true })).toBe(true);
  });

  it("refuses a global setting with an id, and a place without one", () => {
    expect(ok({ type: "GLOBAL", id: "abc", sound: true })).toBe(false);
    expect(ok({ type: "COMMUNITY", sound: true })).toBe(false);
    expect(ok({ type: "CHANNEL", notify: true })).toBe(false);
    expect(ok({ type: "CONVERSATION", sound: true })).toBe(false);
  });

  it("needs something to change, and only booleans or null", () => {
    expect(ok({ type: "GLOBAL" })).toBe(false);
    expect(ok({ type: "GLOBAL", sound: "yes" })).toBe(false);
    expect(ok({ type: "GLOBAL", sound: 1 })).toBe(false);
    expect(ok({ type: "GLOBAL", notify: undefined })).toBe(false);
  });

  it("refuses an unknown type, a malformed or oversized id, and fields it does not know", () => {
    expect(ok({ type: "EVERYTHING", sound: true })).toBe(false);
    expect(ok({ type: "CHANNEL", id: "", sound: true })).toBe(false);
    expect(ok({ type: "CHANNEL", id: "a b", sound: true })).toBe(false);
    expect(ok({ type: "CHANNEL", id: "../x", sound: true })).toBe(false);
    expect(ok({ type: "CHANNEL", id: "a".repeat(65), sound: true })).toBe(false);
    expect(ok({ type: "CHANNEL", id: "a".repeat(64), sound: true })).toBe(true);
    expect(ok({ type: "GLOBAL", sound: true, extra: 1 })).toBe(false);
  });
});

describe("applyChange", () => {
  it("replaces the choices it names and leaves the others", () => {
    expect(applyChange({ sound: true, notify: false }, { sound: false })).toEqual({ sound: false, notify: false, empty: false });
    expect(applyChange({ sound: true, notify: false }, { notify: true })).toEqual({ sound: true, notify: true, empty: false });
  });

  it("takes a choice away with null", () => {
    expect(applyChange({ sound: true, notify: false }, { sound: null })).toEqual({ sound: null, notify: false, empty: false });
  });

  it("is empty only when no choice is left, which is when nothing needs storing", () => {
    expect(applyChange({ sound: true, notify: null }, { sound: null })).toEqual({ sound: null, notify: null, empty: true });
    expect(applyChange(null, { sound: null, notify: null }).empty).toBe(true);
    expect(applyChange(null, { sound: false })).toEqual({ sound: false, notify: null, empty: false });
  });
});

describe("serializeSetting", () => {
  it("names the global setting by no id", () => {
    expect(serializeSetting({ targetType: "GLOBAL", targetId: "", sound: false, notify: null })).toEqual({ type: "GLOBAL", id: null, sound: false, notify: null });
    expect(serializeSetting({ targetType: "CHANNEL", targetId: "c1", sound: null, notify: true })).toEqual({ type: "CHANNEL", id: "c1", sound: null, notify: true });
  });

  it("has a cap that is large but finite", () => {
    expect(MAX_SETTINGS_PER_USER).toBeGreaterThanOrEqual(100);
    expect(MAX_SETTINGS_PER_USER).toBeLessThanOrEqual(10_000);
  });
});
