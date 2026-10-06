import { describe, expect, it } from "vitest";
import { identityFor, newProtocolId, parseIdentity } from "./ids.js";

describe("newProtocolId", () => {
  it("generates a 26-character ULID", () => {
    const id = newProtocolId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("generates unique values", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newProtocolId()));
    expect(ids.size).toBe(50);
  });
});

describe("identityFor", () => {
  it("formats @username:domain", () => {
    expect(identityFor("alice", "alice.test")).toBe("@alice:alice.test");
  });
});

describe("parseIdentity", () => {
  it("parses a bare username using the default domain", () => {
    expect(parseIdentity("bob", "alice.test")).toEqual({ username: "bob", domain: "alice.test" });
  });

  it("parses a full @user:domain identity", () => {
    expect(parseIdentity("@bob:bob.test", "alice.test")).toEqual({ username: "bob", domain: "bob.test" });
  });

  it("parses a full user:domain identity without the leading @", () => {
    expect(parseIdentity("bob:bob.test", "alice.test")).toEqual({ username: "bob", domain: "bob.test" });
  });

  it("lowercases both username and domain", () => {
    expect(parseIdentity("@Bob:Bob.TEST", "alice.test")).toEqual({ username: "bob", domain: "bob.test" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseIdentity("  @bob:bob.test  ", "alice.test")).toEqual({ username: "bob", domain: "bob.test" });
  });

  it("rejects input with no plausible username", () => {
    expect(parseIdentity("@:bob.test", "alice.test")).toBeNull();
    expect(parseIdentity("", "alice.test")).toBeNull();
    expect(parseIdentity("has a space", "alice.test")).toBeNull();
  });

  it("rejects usernames with characters outside [a-z0-9_]", () => {
    expect(parseIdentity("bob!", "alice.test")).toBeNull();
    expect(parseIdentity("bob@evil.com@alice.test", "alice.test")).toBeNull();
  });
});
