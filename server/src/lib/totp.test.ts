import { describe, expect, it } from "vitest";
import { generateTotpCode, generateTotpSecret, totpAuthUri, verifyTotpCode } from "./totp.js";

describe("generateTotpSecret", () => {
  it("generates a base32 secret long enough for RFC 4226's 128-bit minimum", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(26); // 160 bits base32-encoded
  });

  it("generates a different secret each time", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });
});

describe("totpAuthUri", () => {
  it("produces an otpauth:// URI carrying the issuer, username, and secret", () => {
    const secret = generateTotpSecret();
    const uri = totpAuthUri(secret, "alice", "My Chat Server");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(encodeURIComponent(secret));
    expect(decodeURIComponent(uri)).toContain("alice");
    expect(decodeURIComponent(uri)).toContain("My Chat Server");
  });
});

describe("verifyTotpCode", () => {
  it("accepts a freshly generated code", async () => {
    const secret = generateTotpSecret();
    const code = await generateTotpCode(secret);
    const result = await verifyTotpCode(secret, code);
    expect(result.valid).toBe(true);
    expect(result.timeStep).toEqual(expect.any(Number));
  });

  it("rejects a code generated against a different secret", async () => {
    const secret = generateTotpSecret();
    const otherCode = await generateTotpCode(generateTotpSecret());
    expect((await verifyTotpCode(secret, otherCode)).valid).toBe(false);
  });

  it("rejects a malformed code (non-digit) instead of throwing", async () => {
    const secret = generateTotpSecret();
    expect(await verifyTotpCode(secret, "not-a-code")).toEqual({ valid: false });
  });

  it("rejects an empty code instead of throwing", async () => {
    const secret = generateTotpSecret();
    expect(await verifyTotpCode(secret, "")).toEqual({ valid: false });
  });

  // Regression target: a captured code (e.g. shoulder-surfed, or caught in
  // transit) must not be usable a second time within its own valid window.
  it("rejects a code at or before afterTimeStep - replay protection", async () => {
    const secret = generateTotpSecret();
    const code = await generateTotpCode(secret);
    const first = await verifyTotpCode(secret, code);
    expect(first.valid).toBe(true);

    const replay = await verifyTotpCode(secret, code, first.timeStep);
    expect(replay.valid).toBe(false);
  });

  it("still accepts a fresh code when afterTimeStep is from a much earlier step", async () => {
    const secret = generateTotpSecret();
    const code = await generateTotpCode(secret);
    // Step 1 is from 1970 - nowhere near the current step - so this only
    // confirms afterTimeStep doesn't block unrelated codes, just same-or-earlier ones.
    const result = await verifyTotpCode(secret, code, 1);
    expect(result.valid).toBe(true);
  });
});
