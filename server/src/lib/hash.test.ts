import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("is deterministic", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
  });

  it("matches the known SHA-256 digest of an empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("produces different digests for different inputs", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
