import { describe, expect, it } from "vitest";
import { DEFAULT_GRACE_DAYS, parseAccountDeletionGraceDays, purgeDate } from "./accountDeletionGrace.js";

describe("parseAccountDeletionGraceDays", () => {
  it("is 14 days when unset or empty", () => {
    expect(parseAccountDeletionGraceDays(undefined)).toBe(DEFAULT_GRACE_DAYS);
    expect(parseAccountDeletionGraceDays("")).toBe(14);
    expect(parseAccountDeletionGraceDays("  ")).toBe(14);
  });

  it("takes a whole number of days from 0 to 365", () => {
    expect(parseAccountDeletionGraceDays("0")).toBe(0);
    expect(parseAccountDeletionGraceDays("7")).toBe(7);
    expect(parseAccountDeletionGraceDays(" 30 ")).toBe(30);
    expect(parseAccountDeletionGraceDays("365")).toBe(365);
  });

  it("refuses anything else, saying what it wants, instead of guessing", () => {
    for (const bad of ["366", "-1", "7d", "1.5", "seven", "1e2", "0x10", "9999"]) {
      expect(() => parseAccountDeletionGraceDays(bad), bad).toThrow(/ACCOUNT_DELETION_GRACE_DAYS.*0 to 365/s);
    }
  });
});

describe("purgeDate", () => {
  it("is the request plus the grace period", () => {
    expect(purgeDate(new Date("2026-01-01T00:00:00Z"), 14).toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(purgeDate(new Date("2026-01-01T00:00:00Z"), 0).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
