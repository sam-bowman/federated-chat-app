import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPIRY_DAYS,
  DEFAULT_MAX_USES,
  MAX_CODES_PER_CREATE,
  MAX_EXPIRY_DAYS,
  MAX_NOTE_LENGTH,
  MAX_REGISTRATION_USES,
  generateInviteCode,
  normalizeInviteCode,
  parseCreateArgs,
  registrationInviteFailure,
  registrationInviteStatus,
} from "./registrationInvites.js";
import { parseRegistrationInviteOnly } from "./registrationInviteOnly.js";

describe("parseRegistrationInviteOnly", () => {
  it("is off when unset or empty, which is how every server has always behaved", () => {
    expect(parseRegistrationInviteOnly(undefined)).toBe(false);
    expect(parseRegistrationInviteOnly("")).toBe(false);
    expect(parseRegistrationInviteOnly("   ")).toBe(false);
  });

  it("reads the usual ways of saying yes and no, in any case", () => {
    for (const value of ["true", "TRUE", "1", "yes", "On", " true "]) expect(parseRegistrationInviteOnly(value), value).toBe(true);
    for (const value of ["false", "False", "0", "no", "OFF", " false "]) expect(parseRegistrationInviteOnly(value), value).toBe(false);
  });

  it("refuses anything that could be a typo, instead of leaving a server open that was meant to be closed", () => {
    for (const value of ["ture", "tru", "flase", "2", "enabled", "invite"]) {
      expect(() => parseRegistrationInviteOnly(value), value).toThrow(/REGISTRATION_INVITE_ONLY/);
    }
    expect(() => parseRegistrationInviteOnly("ture")).toThrow(/"ture"/);
  });
});

describe("a registration invite code", () => {
  it("is a community invite's kind of code: 10 characters, no look-alikes, matched in any case", () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(normalizeInviteCode(`  ${code.toLowerCase()} `)).toBe(code);
  });

  it("says what is wrong with one that cannot be used, the strongest reason first", () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 100_000);
    const base = { expiresAt: null, maxUses: null, uses: 0, revokedAt: null };
    expect(registrationInviteStatus(base)).toBe("active");
    expect(registrationInviteStatus({ ...base, expiresAt: future, maxUses: 2, uses: 1 })).toBe("active");
    expect(registrationInviteStatus({ ...base, maxUses: 1, uses: 1 })).toBe("used_up");
    expect(registrationInviteStatus({ ...base, expiresAt: past })).toBe("expired");
    expect(registrationInviteStatus({ ...base, revokedAt: past })).toBe("revoked");
    expect(registrationInviteStatus({ ...base, revokedAt: past, expiresAt: past, maxUses: 1, uses: 1 })).toBe("revoked");

    expect(registrationInviteFailure("revoked")).toBe("registration_invite_revoked");
    expect(registrationInviteFailure("expired")).toBe("registration_invite_expired");
    expect(registrationInviteFailure("used_up")).toBe("registration_invite_used_up");
  });
});

describe("parseCreateArgs", () => {
  const ok = (args: string[]) => {
    const parsed = parseCreateArgs(args);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.options;
  };
  const refused = (args: string[]) => {
    const parsed = parseCreateArgs(args);
    if (parsed.ok) throw new Error(`expected a refusal for ${args.join(" ")}`);
    return parsed.message;
  };

  it("makes one single-use code that lasts a week when told nothing", () => {
    expect(ok([])).toEqual({ maxUses: DEFAULT_MAX_USES, expiresInDays: DEFAULT_EXPIRY_DAYS, note: null, count: 1 });
    expect(DEFAULT_MAX_USES).toBe(1);
    expect(DEFAULT_EXPIRY_DAYS).toBe(7);
  });

  it("takes each option on its own", () => {
    expect(ok(["--uses", "5"]).maxUses).toBe(5);
    expect(ok(["--uses", "unlimited"]).maxUses).toBeNull();
    expect(ok(["--days", "30"]).expiresInDays).toBe(30);
    expect(ok(["--days", "never"]).expiresInDays).toBeNull();
    expect(ok(["--count", "3"]).count).toBe(3);
    expect(ok(["--note", "  Alex from work  "]).note).toBe("Alex from work");
    expect(ok(["--note", "   "]).note).toBeNull();
  });

  it("takes them together, in any order", () => {
    expect(ok(["--note", "the group", "--count", "4", "--days", "2", "--uses", "3"])).toEqual({
      maxUses: 3,
      expiresInDays: 2,
      note: "the group",
      count: 4,
    });
  });

  it("holds each number to its limits, inclusive", () => {
    expect(ok(["--uses", "1"]).maxUses).toBe(1);
    expect(ok(["--uses", String(MAX_REGISTRATION_USES)]).maxUses).toBe(MAX_REGISTRATION_USES);
    expect(refused(["--uses", "0"])).toMatch(/--uses/);
    expect(refused(["--uses", String(MAX_REGISTRATION_USES + 1)])).toMatch(/--uses/);
    expect(ok(["--days", String(MAX_EXPIRY_DAYS)]).expiresInDays).toBe(MAX_EXPIRY_DAYS);
    expect(refused(["--days", "0"])).toMatch(/--days/);
    expect(refused(["--days", String(MAX_EXPIRY_DAYS + 1)])).toMatch(/--days/);
    expect(ok(["--count", String(MAX_CODES_PER_CREATE)]).count).toBe(MAX_CODES_PER_CREATE);
    expect(refused(["--count", "0"])).toMatch(/--count/);
    expect(refused(["--count", String(MAX_CODES_PER_CREATE + 1)])).toMatch(/--count/);
    expect(ok(["--note", "x".repeat(MAX_NOTE_LENGTH)]).note).toHaveLength(MAX_NOTE_LENGTH);
    expect(refused(["--note", "x".repeat(MAX_NOTE_LENGTH + 1)])).toMatch(/--note/);
  });

  it("refuses what is not a whole number, rather than reading part of it", () => {
    for (const value of ["abc", "1.5", "-1", "1e3", "0x10", "5 days", ""]) {
      expect(refused(["--uses", value]), value).toMatch(/--uses/);
    }
    expect(refused(["--days", "week"])).toMatch(/--days/);
  });

  it("refuses an option it does not know, so a misspelling cannot leave the default in place", () => {
    expect(refused(["--day", "1"])).toBe('Unknown option "--day".');
    expect(refused(["extra"])).toBe('Unknown option "extra".');
  });

  it("refuses an option with no value, including one that is followed by another option", () => {
    expect(refused(["--uses"])).toBe("--uses needs a value.");
    expect(refused(["--uses", "--days", "3"])).toBe("--uses needs a value.");
  });
});
