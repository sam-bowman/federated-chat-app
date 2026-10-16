import { describe, expect, it } from "vitest";
import { defaultListed, effectiveListed, listingLocked, parseDirectoryPeople } from "./directoryPeople.js";

describe("parseDirectoryPeople", () => {
  it("is default-off when unset or blank: people choose, and start unlisted", () => {
    expect(parseDirectoryPeople(undefined)).toBe("default-off");
    expect(parseDirectoryPeople("")).toBe("default-off");
    expect(parseDirectoryPeople("  ")).toBe("default-off");
  });

  it("reads the three modes, ignoring case and spaces", () => {
    expect(parseDirectoryPeople("default-on")).toBe("default-on");
    expect(parseDirectoryPeople(" Forced-Off ")).toBe("forced-off");
    expect(parseDirectoryPeople("DEFAULT-OFF")).toBe("default-off");
  });

  it.each(["off", "false", "on", "forced", "default_on", "deafult-on"])("refuses %s rather than guessing", (value) => {
    expect(() => parseDirectoryPeople(value)).toThrow(/DIRECTORY_PEOPLE.*default-off, default-on, forced-off/);
  });
});

describe("what a mode means", () => {
  it("starts new accounts listed only in default-on", () => {
    expect(defaultListed("default-on")).toBe(true);
    expect(defaultListed("default-off")).toBe(false);
    expect(defaultListed("forced-off")).toBe(false);
  });

  it("takes the choice away only when forced", () => {
    expect(listingLocked("forced-off")).toBe(true);
    expect(listingLocked("default-on")).toBe(false);
    expect(listingLocked("default-off")).toBe(false);
  });

  it("lets a person narrow what the server allows but never widen it", () => {
    expect(effectiveListed("default-off", true)).toBe(true);
    expect(effectiveListed("default-off", false)).toBe(false);
    expect(effectiveListed("default-on", false)).toBe(false);
    expect(effectiveListed("forced-off", true)).toBe(false);
  });
});
