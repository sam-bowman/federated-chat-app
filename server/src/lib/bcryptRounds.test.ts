import { describe, expect, it } from "vitest";
import {
  DEFAULT_BCRYPT_ROUNDS,
  bcryptRoundsProblem,
  parseBcryptRounds,
} from "./bcryptRounds.js";

describe("parseBcryptRounds", () => {
  // Cost 12 is what real deployments must keep getting when nobody sets anything.
  it("defaults to 12 when unset or blank", () => {
    expect(DEFAULT_BCRYPT_ROUNDS).toBe(12);
    expect(parseBcryptRounds(undefined)).toBe(12);
    expect(parseBcryptRounds("")).toBe(12);
    expect(parseBcryptRounds("   ")).toBe(12);
  });

  it("accepts any whole number bcrypt allows, ignoring surrounding spaces", () => {
    expect(parseBcryptRounds("4")).toBe(4);
    expect(parseBcryptRounds(" 10 ")).toBe(10);
    expect(parseBcryptRounds("14")).toBe(14);
    expect(parseBcryptRounds("31")).toBe(31);
  });

  it.each(["3", "0", "32", "-5", "12.5", "twelve", "1e1", "0x0c", "12abc"])("refuses %j, naming the setting", (raw) => {
    expect(() => parseBcryptRounds(raw)).toThrow(/BCRYPT_ROUNDS must be a whole number from 4 to 31/);
  });
});

describe("bcryptRoundsProblem", () => {
  it("has nothing to say about the default or a strong setting", () => {
    expect(bcryptRoundsProblem(undefined)).toBeNull();
    expect(bcryptRoundsProblem("10")).toBeNull();
    expect(bcryptRoundsProblem("12")).toBeNull();
    expect(bcryptRoundsProblem("15")).toBeNull();
  });

  it("flags a work factor too low to run a real server with", () => {
    const problem = bcryptRoundsProblem("4");
    expect(problem).toContain("BCRYPT_ROUNDS=4");
    expect(problem).toContain("cheap to crack");
    expect(bcryptRoundsProblem("9")).not.toBeNull();
  });

  it("still refuses a value bcrypt cannot use at all", () => {
    expect(() => bcryptRoundsProblem("2")).toThrow();
  });
});
