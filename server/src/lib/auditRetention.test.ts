import { describe, expect, it } from "vitest";
import { DEFAULT_RETENTION_DAYS, parseAuditRetentionDays } from "./auditRetention.js";

describe("parseAuditRetentionDays", () => {
  it("is a year when unset or empty", () => {
    expect(parseAuditRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(parseAuditRetentionDays("")).toBe(365);
  });

  it("takes a whole number of days from 0 (keep for ever) to 3650", () => {
    expect(parseAuditRetentionDays("0")).toBe(0);
    expect(parseAuditRetentionDays("90")).toBe(90);
    expect(parseAuditRetentionDays(" 3650 ")).toBe(3650);
  });

  it("refuses anything else, saying what it wants", () => {
    for (const bad of ["3651", "-1", "90d", "1.5", "forever", "1e3", "99999"]) {
      expect(() => parseAuditRetentionDays(bad), bad).toThrow(/AUDIT_LOG_RETENTION_DAYS.*0 to 3650/s);
    }
  });
});
