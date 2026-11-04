import { describe, expect, it } from "vitest";
import { parseBotsEnabled, parseBotsPerUserLimit } from "./botsEnabled.js";

describe("BOTS_ENABLED", () => {
  it("is on unless clearly switched off", () => {
    for (const v of [undefined, "", "  ", "true", "TRUE", "1", "yes", "on"]) expect(parseBotsEnabled(v)).toBe(true);
    for (const v of ["false", "False", "0", "no", "off", " off "]) expect(parseBotsEnabled(v)).toBe(false);
  });

  it("refuses a value that could be a typo, rather than leaving bots on", () => {
    for (const v of ["fasle", "disabled", "2", "maybe"]) expect(() => parseBotsEnabled(v)).toThrow(/BOTS_ENABLED/);
  });
});

describe("BOTS_PER_USER_LIMIT", () => {
  it("defaults to 5 and takes a whole number from 0 to 50", () => {
    expect(parseBotsPerUserLimit(undefined)).toBe(5);
    expect(parseBotsPerUserLimit("")).toBe(5);
    expect(parseBotsPerUserLimit("0")).toBe(0);
    expect(parseBotsPerUserLimit("50")).toBe(50);
  });

  it("refuses anything else", () => {
    for (const v of ["-1", "51", "2.5", "many", "1e1x"]) expect(() => parseBotsPerUserLimit(v)).toThrow(/BOTS_PER_USER_LIMIT/);
  });
});
