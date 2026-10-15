import { describe, expect, it } from "vitest";
import { defaultDiscoverable, discoverabilityLocked, effectiveDiscoverable, parseUserDiscoverability } from "./userDiscoverability.js";

describe("parseUserDiscoverability", () => {
  it("is default-on when unset or blank, which is how every server has behaved", () => {
    expect(parseUserDiscoverability(undefined)).toBe("default-on");
    expect(parseUserDiscoverability("")).toBe("default-on");
    expect(parseUserDiscoverability("  ")).toBe("default-on");
  });

  it("reads the three modes, ignoring case and spaces", () => {
    expect(parseUserDiscoverability("default-on")).toBe("default-on");
    expect(parseUserDiscoverability(" Default-Off ")).toBe("default-off");
    expect(parseUserDiscoverability("FORCED-OFF")).toBe("forced-off");
  });

  it.each(["off", "false", "hidden", "default_off", "forced", "yes", "defualt-off"])("refuses %s rather than guessing what was meant", (value) => {
    expect(() => parseUserDiscoverability(value)).toThrow(/FEDERATION_USER_DISCOVERABILITY.*default-on, default-off, forced-off/);
  });
});

describe("what a mode means", () => {
  it("starts new accounts findable only in default-on", () => {
    expect(defaultDiscoverable("default-on")).toBe(true);
    expect(defaultDiscoverable("default-off")).toBe(false);
    expect(defaultDiscoverable("forced-off")).toBe(false);
  });

  it("lets a person narrow what the server allows but never widen it", () => {
    expect(effectiveDiscoverable("default-on", true)).toBe(true);
    expect(effectiveDiscoverable("default-on", false)).toBe(false);
    expect(effectiveDiscoverable("default-off", true)).toBe(true); // a person who opted in is findable
    expect(effectiveDiscoverable("forced-off", true)).toBe(false); // whatever they chose
    expect(effectiveDiscoverable("forced-off", false)).toBe(false);
  });

  it("takes the choice away only when forced", () => {
    expect(discoverabilityLocked("forced-off")).toBe(true);
    expect(discoverabilityLocked("default-on")).toBe(false);
    expect(discoverabilityLocked("default-off")).toBe(false);
  });
});
