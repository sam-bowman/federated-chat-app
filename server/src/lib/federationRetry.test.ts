import { describe, expect, it } from "vitest";
import { DEFAULT_FEDERATION_RETRY_BASE_MS, parseFederationRetryBaseMs } from "./federationRetry.js";

describe("parseFederationRetryBaseMs", () => {
  // Production behaviour is the unchanged 500 ms unless someone sets this, which only the tests do.
  it("defaults to 500 ms when unset or blank", () => {
    expect(DEFAULT_FEDERATION_RETRY_BASE_MS).toBe(500);
    expect(parseFederationRetryBaseMs(undefined)).toBe(500);
    expect(parseFederationRetryBaseMs("")).toBe(500);
    expect(parseFederationRetryBaseMs("  ")).toBe(500);
  });

  it("accepts a whole number of milliseconds from 0 to 10000", () => {
    expect(parseFederationRetryBaseMs("0")).toBe(0);
    expect(parseFederationRetryBaseMs(" 1 ")).toBe(1);
    expect(parseFederationRetryBaseMs("10000")).toBe(10000);
  });

  it.each(["-1", "10001", "1.5", "fast", "1e3", "5s"])("refuses %j, naming the setting", (raw) => {
    expect(() => parseFederationRetryBaseMs(raw)).toThrow(/FEDERATION_RETRY_BASE_MS must be a whole number/);
  });
});
