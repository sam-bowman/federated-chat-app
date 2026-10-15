import { describe, expect, it } from "vitest";
import { PRESENCE_OPTIONS, statusLabel, statusLine } from "./presence";

describe("PRESENCE_OPTIONS", () => {
  it("offers the five statuses a person can set, in order, each with a description", () => {
    expect(PRESENCE_OPTIONS.map((o) => o.value)).toEqual(["ONLINE", "AWAY", "BUSY", "DO_NOT_DISTURB", "INVISIBLE"]);
    for (const option of PRESENCE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  it("does not offer offline, which is what others see when you are not connected", () => {
    expect(PRESENCE_OPTIONS.map((o) => o.value)).not.toContain("OFFLINE");
  });
});

describe("statusLabel", () => {
  it.each([
    ["ONLINE", "Online"],
    ["AWAY", "Away"],
    ["BUSY", "Busy"],
    ["DO_NOT_DISTURB", "Do not disturb"],
    ["INVISIBLE", "Invisible"],
    ["OFFLINE", "Offline"],
  ])("says %s as %s", (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });

  it("makes an unknown status readable instead of showing it raw", () => {
    expect(statusLabel("SOMETHING_NEW")).toBe("Something new");
  });
});

describe("statusLine", () => {
  it("is the label, except for invisible, which says what others see", () => {
    expect(statusLine("BUSY")).toBe("Busy");
    expect(statusLine("INVISIBLE")).toBe("Invisible (others see you offline)");
  });
});
