import { describe, expect, it } from "vitest";
import { parseFederationEnabled } from "./federationEnabled.js";

describe("parseFederationEnabled", () => {
  it("is on when unset or empty, which is how every server has always behaved", () => {
    expect(parseFederationEnabled(undefined)).toBe(true);
    expect(parseFederationEnabled("")).toBe(true);
    expect(parseFederationEnabled("   ")).toBe(true);
  });

  it("reads the usual ways of saying yes", () => {
    for (const value of ["true", "TRUE", "True", "1", "yes", "YES", "on", "On", " true "]) {
      expect(parseFederationEnabled(value), value).toBe(true);
    }
  });

  it("reads the usual ways of saying no", () => {
    for (const value of ["false", "FALSE", "False", "0", "no", "NO", "off", "Off", " false "]) {
      expect(parseFederationEnabled(value), value).toBe(false);
    }
  });

  // The reason this is not "anything but false is on": a typo must not leave a server the operator meant to be private public.
  it("refuses a value that is neither, saying what it should be, rather than guessing", () => {
    for (const value of ["fasle", "flase", "disabled", "enabled", "2", "-1", "nope", "tru", "n", "y", "null", "undefined", "false;", "false true"]) {
      expect(() => parseFederationEnabled(value), value).toThrow(/FEDERATION_ENABLED is ".*", which is not true or false/);
    }
  });

  it("quotes the value as given in the error, so the typo is visible", () => {
    expect(() => parseFederationEnabled("fasle")).toThrow('FEDERATION_ENABLED is "fasle"');
  });
});
