import { describe, expect, it } from "vitest";
import serverSettings from "../../../server/src/lib/serverSettings.ts?raw";
import type { AdminSetting } from "../api";
import { SETTING_GROUPS, SETTING_TEXT, domainsToLines, draftToValue, isDirty, sourceWords, valueLabel } from "./adminSettings";

const setting = (over: Partial<AdminSetting>): AdminSetting => ({
  key: "LINK_PREVIEWS_ENABLED",
  group: "server",
  kind: "boolean",
  choices: null,
  value: "false",
  source: "default",
  locked: false,
  default: "false",
  updatedAt: null,
  problem: null,
  ...over,
});

describe("SETTING_TEXT (#206 phase 4)", () => {
  it("has words for every setting the server can send, and for nothing it cannot", () => {
    // Every definition in the server's list names its environment variable as `key: "X"` or as the first argument of choiceSetting("X".
    const sent = [...serverSettings.matchAll(/(?:key: |choiceSetting\()"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]).sort();
    expect(sent.length).toBeGreaterThanOrEqual(14);
    expect(Object.keys(SETTING_TEXT).sort()).toEqual(sent);
  });

  it("puts every group the server uses on the page", () => {
    const used = [...serverSettings.matchAll(/group: "(\w+)"/g), ...serverSettings.matchAll(/choiceSetting\("[A-Z_]+", "(\w+)"/g)].map((m) => m[1]);
    expect(SETTING_GROUPS.map((g) => g.id).sort()).toEqual([...new Set(used)].sort());
  });

  it("says what each does, in a sentence, and never shows a variable name as its label", () => {
    for (const [key, text] of Object.entries(SETTING_TEXT)) {
      expect(text.help.length, key).toBeGreaterThan(30);
      expect(text.label, key).not.toMatch(/_/);
    }
  });
});

describe("valueLabel", () => {
  it("reads a switch in the setting's own words, and a choice the way the rest of the app says it", () => {
    expect(valueLabel(setting({ key: "FEDERATION_ENABLED", value: "false" }), "false")).toBe("Off: private");
    expect(valueLabel(setting({ key: "REGISTRATION_ENABLED" }), "true")).toBe("Open");
    expect(valueLabel(setting({ key: "FEDERATION_CONTACT_POLICY_LIMIT", kind: "choice" }), "SHARED_COMMUNITY")).toBe("People who share a community with them");
    expect(valueLabel(setting({ key: "FEDERATION_USER_DISCOVERABILITY", kind: "choice" }), "forced-off")).toBe("Nobody is findable");
  });

  it("shows a list of servers as a list, and an empty one as None", () => {
    const list = setting({ key: "FEDERATION_ALLOWED_DOMAINS", kind: "domains" });
    expect(valueLabel(list, "")).toBe("None");
    expect(valueLabel(list, "a.example.com,b.example.com")).toBe("a.example.com, b.example.com");
  });

  it("shows a value it has no words for as it came", () => {
    expect(valueLabel(setting({ key: "SERVER_NAME", kind: "text" }), "Our Place")).toBe("Our Place");
  });
});

describe("the box and the value", () => {
  const list = setting({ key: "FEDERATION_BLOCKED_DOMAINS", kind: "domains", value: "a.example.com,b.example.com" });

  it("shows a list one server per line and reads lines or commas back", () => {
    expect(domainsToLines("a.example.com,b.example.com")).toBe("a.example.com\nb.example.com");
    expect(domainsToLines("")).toBe("");
    expect(draftToValue(list, " a.example.com \n\nb.example.com, c.example.com\r\n")).toBe("a.example.com,b.example.com,c.example.com");
  });

  it("is only dirty when there is something to save; a list is compared as the server keeps it", () => {
    expect(isDirty(list, domainsToLines(list.value))).toBe(false);
    expect(isDirty(list, "A.example.com\nb.example.com")).toBe(false);
    expect(isDirty(list, "a.example.com")).toBe(true);
    expect(isDirty(setting({ value: "false" }), "false")).toBe(false);
    expect(isDirty(setting({ value: "false" }), "true")).toBe(true);
    expect(isDirty(setting({ key: "SERVER_NAME", kind: "text", value: "Our Place" }), "  Our Place ")).toBe(false);
  });
});

describe("sourceWords", () => {
  it("says where a value comes from", () => {
    expect(sourceWords(setting({ source: "environment" }))).toMatch(/environment/);
    expect(sourceWords(setting({ source: "database" }))).toBe("Changed here");
    expect(sourceWords(setting({ source: "default" }))).toBe("Default");
  });
});
