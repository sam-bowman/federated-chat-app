import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  Permission,
  combinePermissions,
  hasPermission,
} from "./permissions.js";

describe("hasPermission", () => {
  it("is true when the flag bit is set", () => {
    expect(hasPermission(Permission.KICK_MEMBERS, Permission.KICK_MEMBERS)).toBe(true);
  });

  it("is true when the flag is a subset of a combined mask", () => {
    const combined = Permission.KICK_MEMBERS | Permission.BAN_MEMBERS | Permission.SEND_MESSAGES;
    expect(hasPermission(combined, Permission.BAN_MEMBERS)).toBe(true);
  });

  it("is false when the flag bit is not set", () => {
    expect(hasPermission(Permission.SEND_MESSAGES, Permission.BAN_MEMBERS)).toBe(false);
  });

  it("is false against an empty mask", () => {
    expect(hasPermission(0n, Permission.SEND_MESSAGES)).toBe(false);
  });

  it("ALL_PERMISSIONS grants every individual permission", () => {
    for (const flag of Object.values(Permission)) {
      expect(hasPermission(ALL_PERMISSIONS, flag)).toBe(true);
    }
  });
});

describe("combinePermissions", () => {
  it("ORs together multiple role bitmasks", () => {
    const combined = combinePermissions([Permission.SEND_MESSAGES, Permission.REACT]);
    expect(hasPermission(combined, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(combined, Permission.REACT)).toBe(true);
    expect(hasPermission(combined, Permission.BAN_MEMBERS)).toBe(false);
  });

  it("returns 0n for an empty list", () => {
    expect(combinePermissions([])).toBe(0n);
  });

  it("matches DEFAULT_MEMBER_PERMISSIONS for the @everyone role shape", () => {
    expect(DEFAULT_MEMBER_PERMISSIONS).toBe(Permission.SEND_MESSAGES | Permission.REACT);
  });
});
