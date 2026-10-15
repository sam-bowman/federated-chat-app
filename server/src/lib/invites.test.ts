import { describe, expect, it } from "vitest";
import {
  CARD_INVITE_EXPIRY_SECONDS,
  INVITE_CODE_LENGTH,
  INVITE_CODE_PATTERN,
  INVITE_EXPIRY_CHOICES_SECONDS,
  MAX_INVITE_USES,
  createInviteSchema,
  generateInviteCode,
  inviteFailureCode,
  inviteJoinReference,
  inviteStatus,
  normalizeInviteCode,
  parseJoinReference,
} from "./invites.js";

describe("generateInviteCode", () => {
  it("is ten characters from an alphabet with no look-alikes", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/); // no I, L, O or U
      expect(code).toMatch(INVITE_CODE_PATTERN);
    }
  });

  it("does not repeat (50 random bits)", () => {
    const codes = new Set(Array.from({ length: 2000 }, generateInviteCode));
    expect(codes.size).toBe(2000);
  });

  it("uses every character of the alphabet about equally, since 256 divides by 32", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 3000; i++) for (const ch of generateInviteCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    const values = [...counts.values()];
    // 30000 characters over 32 symbols is 937 each; a skewed generator would be far off.
    expect(Math.min(...values)).toBeGreaterThan(780);
    expect(Math.max(...values)).toBeLessThan(1100);
  });
});

describe("normalizeInviteCode", () => {
  it("makes a code typed in lower case, or with spaces round it, the stored form", () => {
    expect(normalizeInviteCode(" abcd1234xy ")).toBe("ABCD1234XY");
  });
});

describe("inviteStatus", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const base = { expiresAt: null, maxUses: null, uses: 0, revokedAt: null };

  it("is active with no limits", () => {
    expect(inviteStatus(base, now)).toBe("active");
    expect(inviteStatus({ ...base, uses: 5000 }, now)).toBe("active");
  });

  it("expires at its expiry time, not a moment before", () => {
    const expiresAt = new Date("2026-10-15T12:00:00Z");
    expect(inviteStatus({ ...base, expiresAt }, new Date(expiresAt.getTime() - 1))).toBe("active");
    expect(inviteStatus({ ...base, expiresAt }, expiresAt)).toBe("expired");
    expect(inviteStatus({ ...base, expiresAt }, new Date(expiresAt.getTime() + 1))).toBe("expired");
  });

  it("is used up when its uses reach its limit", () => {
    expect(inviteStatus({ ...base, maxUses: 3, uses: 2 }, now)).toBe("active");
    expect(inviteStatus({ ...base, maxUses: 3, uses: 3 }, now)).toBe("used_up");
    expect(inviteStatus({ ...base, maxUses: 3, uses: 4 }, now)).toBe("used_up");
  });

  it("is revoked once revoked, whatever else is true of it", () => {
    const revokedAt = new Date("2026-10-01T00:00:00Z");
    expect(inviteStatus({ ...base, revokedAt }, now)).toBe("revoked");
    expect(inviteStatus({ expiresAt: new Date("2026-01-01"), maxUses: 1, uses: 1, revokedAt }, now)).toBe("revoked");
  });

  it("says expired rather than used up when both are true", () => {
    expect(inviteStatus({ ...base, expiresAt: new Date("2026-01-01"), maxUses: 1, uses: 1 }, now)).toBe("expired");
  });
});

describe("inviteFailureCode", () => {
  it("names each way an invite can fail, as the error a join answers with", () => {
    expect(inviteFailureCode("revoked")).toBe("invite_revoked");
    expect(inviteFailureCode("expired")).toBe("invite_expired");
    expect(inviteFailureCode("used_up")).toBe("invite_used_up");
  });
});

describe("createInviteSchema", () => {
  it("accepts nothing at all, meaning no expiry and no limit", () => {
    expect(createInviteSchema.parse({})).toEqual({});
  });

  it("accepts each offered lifetime, and never", () => {
    for (const seconds of INVITE_EXPIRY_CHOICES_SECONDS) expect(createInviteSchema.safeParse({ expiresInSeconds: seconds }).success).toBe(true);
    expect(createInviteSchema.safeParse({ expiresInSeconds: null }).success).toBe(true);
    expect(INVITE_EXPIRY_CHOICES_SECONDS).toContain(CARD_INVITE_EXPIRY_SECONDS);
  });

  it("refuses any other lifetime, so no one can ask for a year, a negative number or a second", () => {
    for (const bad of [1, 59, 3601, -3600, 31_536_000, 0, 1.5, "3600"]) {
      expect(createInviteSchema.safeParse({ expiresInSeconds: bad }).success, String(bad)).toBe(false);
    }
  });

  it("accepts a use limit from 1 to the maximum, and refuses the rest", () => {
    expect(createInviteSchema.safeParse({ maxUses: 1 }).success).toBe(true);
    expect(createInviteSchema.safeParse({ maxUses: MAX_INVITE_USES }).success).toBe(true);
    expect(createInviteSchema.safeParse({ maxUses: null }).success).toBe(true);
    for (const bad of [0, -1, MAX_INVITE_USES + 1, 2.5, "5", Infinity, NaN]) {
      expect(createInviteSchema.safeParse({ maxUses: bad }).success, String(bad)).toBe(false);
    }
  });
});

describe("parseJoinReference", () => {
  it("reads a bare community id as one on this server", () => {
    expect(parseJoinReference("01ABCDEF", "chat.example")).toEqual({ protocolId: "01ABCDEF", domain: "chat.example", code: null });
  });

  it("reads an id and server, and lower-cases the server but never the id", () => {
    expect(parseJoinReference("01ABCDEF:Other.Example", "chat.example")).toEqual({ protocolId: "01ABCDEF", domain: "other.example", code: null });
  });

  it("keeps a port with the server", () => {
    expect(parseJoinReference("01ABCDEF:localhost:4001", "x")?.domain).toBe("localhost:4001");
  });

  it("reads the invite after a #, with or without a server", () => {
    expect(parseJoinReference("01ABCDEF:other.example#K7M2QXR9TB", "x")).toEqual({ protocolId: "01ABCDEF", domain: "other.example", code: "K7M2QXR9TB" });
    expect(parseJoinReference("01ABCDEF#K7M2QXR9TB", "chat.example")).toEqual({ protocolId: "01ABCDEF", domain: "chat.example", code: "K7M2QXR9TB" });
  });

  it("keeps the case of the code", () => {
    expect(parseJoinReference("01ABCDEF#abcdefgh12", "x")?.code).toBe("abcdefgh12");
  });

  it("refuses a code that cannot be one, so junk after a # is an error and not a silent open join", () => {
    for (const bad of ["01ABCDEF#", "01ABCDEF#abc", "01ABCDEF#has space", "01ABCDEF#a-b-c-d-e-f", "01ABCDEF#" + "A".repeat(33)]) {
      expect(parseJoinReference(bad, "x"), bad).toBeNull();
    }
  });

  it("refuses what is not a community reference at all", () => {
    for (const bad of ["", "   ", "a b", "#CODE12345", "01ABCDEF:", "01ABCDEF:a b"]) {
      expect(parseJoinReference(bad, "x"), JSON.stringify(bad)).toBeNull();
    }
  });

  it("round-trips a full reference", () => {
    const text = inviteJoinReference({ protocolId: "01ABCDEF", homeserverDomain: "other.example" }, "K7M2QXR9TB");

    expect(text).toBe("01ABCDEF:other.example#K7M2QXR9TB");
    expect(parseJoinReference(text, "x")).toEqual({ protocolId: "01ABCDEF", domain: "other.example", code: "K7M2QXR9TB" });
  });
});
