import { describe, expect, it } from "vitest";
import { NO_SUCH_WEBHOOK_HASH, generateWebhookSecret, hashWebhookSecret, looksLikeWebhookSecret, secretMatches } from "./webhookSecret.js";

describe("a webhook's secret", () => {
  it("is mcw_ and 43 characters of base64url, and never the same twice", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^mcw_[A-Za-z0-9_-]{43}$/);
    expect(looksLikeWebhookSecret(a)).toBe(true);
    expect(generateWebhookSecret()).not.toBe(a);
  });

  it("is recognised by its shape only when it has it", () => {
    for (const v of ["", "mcw_", "mcw_short", `mcb_${"a".repeat(43)}`, `mcw_${"a".repeat(44)}`, `mcw_${"a".repeat(42)}!`, ` mcw_${"a".repeat(43)}`]) {
      expect(looksLikeWebhookSecret(v)).toBe(false);
    }
  });

  it("is kept as a SHA-256 fingerprint, which is what a presented one is compared with", () => {
    const secret = generateWebhookSecret();
    const stored = hashWebhookSecret(secret);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(secret);
    expect(secretMatches(secret, stored)).toBe(true);
    expect(secretMatches(generateWebhookSecret(), stored)).toBe(false);
  });

  it("never matches the hash used for a webhook that does not exist", () => {
    expect(secretMatches(generateWebhookSecret(), NO_SUCH_WEBHOOK_HASH)).toBe(false);
  });

  it("does not throw on a stored value that is not a hash (it is a no)", () => {
    expect(secretMatches(generateWebhookSecret(), "not hex")).toBe(false);
    expect(secretMatches(generateWebhookSecret(), "")).toBe(false);
  });
});
