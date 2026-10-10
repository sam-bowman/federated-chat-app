import { describe, expect, it } from "vitest";
import { generateRecoveryCodes, hashRecoveryCode, RECOVERY_CODE_COUNT } from "./recoveryCodes.js";

describe("generateRecoveryCodes", () => {
  it("generates RECOVERY_CODE_COUNT codes by default, each dash-grouped", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    }
  });

  it("generates all-unique codes", () => {
    const codes = generateRecoveryCodes(50);
    expect(new Set(codes).size).toBe(50);
  });

  it("respects an explicit count", () => {
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });
});

describe("hashRecoveryCode", () => {
  it("is deterministic for the same code", () => {
    expect(hashRecoveryCode("abcd-ef01-2345")).toBe(hashRecoveryCode("abcd-ef01-2345"));
  });

  it("produces different hashes for different codes", () => {
    expect(hashRecoveryCode("abcd-ef01-2345")).not.toBe(hashRecoveryCode("ffff-ffff-ffff"));
  });

  // A user pasting a recovery code may pick up stray whitespace or shifted
  // case - normalize before hashing so it still matches what was stored.
  it("normalizes case and surrounding whitespace before hashing", () => {
    const canonical = hashRecoveryCode("abcd-ef01-2345");
    expect(hashRecoveryCode("ABCD-EF01-2345")).toBe(canonical);
    expect(hashRecoveryCode("  abcd-ef01-2345  ")).toBe(canonical);
  });
});
