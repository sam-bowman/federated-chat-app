import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "./trustProxy.js";

describe("parseTrustProxy", () => {
  it("trusts no proxy by default", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("  ")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("0")).toBe(false);
  });

  it("takes a number of hops", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy(" 2 ")).toBe(2);
  });

  it("takes a list of keywords, addresses and ranges, ignoring spaces", () => {
    expect(parseTrustProxy("loopback, 10.0.0.0/8 ,192.168.1.5,fd00::/8")).toEqual([
      "loopback",
      "10.0.0.0/8",
      "192.168.1.5",
      "fd00::/8",
    ]);
    expect(parseTrustProxy("uniquelocal")).toEqual(["uniquelocal"]);
  });

  it("refuses 'true', which would believe any X-Forwarded-For a client sends", () => {
    expect(() => parseTrustProxy("true")).toThrow(/trusts every address/);
    expect(() => parseTrustProxy("TRUE")).toThrow(/trusts every address/);
  });

  it("refuses catch-all ranges for the same reason", () => {
    expect(() => parseTrustProxy("0.0.0.0/0")).toThrow(/trusts every address/);
    expect(() => parseTrustProxy("loopback,::/0")).toThrow(/trusts every address/);
  });

  it("rejects malformed entries, naming them", () => {
    expect(() => parseTrustProxy("traefik")).toThrow(/"traefik" is not valid/);
    expect(() => parseTrustProxy("10.0.0.0/33")).toThrow(/"10.0.0.0\/33" is not valid/);
    expect(() => parseTrustProxy("10.0.0.0/8/8")).toThrow(/not valid/);
    expect(() => parseTrustProxy("999.1.1.1")).toThrow(/not valid/);
    expect(() => parseTrustProxy("1, loopback")).toThrow(/"1" is not valid/);
  });
});
