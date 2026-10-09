import { describe, expect, it } from "vitest";
import { backoffMs } from "./outboxBackoff.js";

describe("backoffMs", () => {
  it("returns baseDelayMs for the first attempt", () => {
    expect(backoffMs(1, 1000, 60000)).toBe(1000);
  });

  it("doubles with each subsequent attempt", () => {
    expect(backoffMs(2, 1000, 60000)).toBe(2000);
    expect(backoffMs(3, 1000, 60000)).toBe(4000);
    expect(backoffMs(4, 1000, 60000)).toBe(8000);
  });

  it("caps at maxDelayMs instead of growing unbounded", () => {
    expect(backoffMs(10, 1000, 60000)).toBe(60000);
    expect(backoffMs(100, 1000, 60000)).toBe(60000);
  });
});
