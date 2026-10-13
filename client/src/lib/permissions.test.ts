import { describe, expect, it } from "vitest";
// Read as plain text (Vite's ?raw) rather than via node:fs - this folder is
// browser-scoped (tsconfig.app.json deliberately has no Node types).
import serverSource from "../../../server/src/lib/permissions.ts?raw";
import { ROLE_PERMISSIONS, describePermissions, hasPermissionBit, withPermissionBit } from "./permissions";

// The client can't import the server, so its copy of the permission bits is
// checked against the server's source text instead - if a bit is ever renumbered
// on one side only, this fails rather than a role silently granting the wrong thing.
describe("ROLE_PERMISSIONS stays in step with the server's permission bits", () => {
  const serverBits = new Map(
    [...serverSource.matchAll(/^\s*([A-Z_]+):\s*1n\s*<<\s*(\d+)n/gm)].map((m) => [m[1], 1n << BigInt(m[2])])
  );

  it("found the server's definitions at all", () => {
    expect(serverBits.size).toBeGreaterThanOrEqual(9);
  });

  it.each(ROLE_PERMISSIONS.map((p) => [p.key, p.bit] as const))("%s has the same bit as the server", (key, bit) => {
    expect(serverBits.get(key)).toBe(bit);
  });

  it("offers every permission the server defines, so none is left defined but unusable", () => {
    const offered = new Set(ROLE_PERMISSIONS.map((p) => p.key));
    for (const key of serverBits.keys()) expect(offered.has(key)).toBe(true);
  });

  it("only offers permissions the server defines, each once", () => {
    const keys = ROLE_PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(serverBits.has(key)).toBe(true);
  });
});

describe("permission helpers", () => {
  const kick = ROLE_PERMISSIONS.find((p) => p.key === "KICK_MEMBERS")!.bit;
  const ban = ROLE_PERMISSIONS.find((p) => p.key === "BAN_MEMBERS")!.bit;

  it("turns bits on and off without disturbing the others", () => {
    const both = withPermissionBit(withPermissionBit("0", kick, true), ban, true);
    expect(hasPermissionBit(both, kick)).toBe(true);
    expect(hasPermissionBit(both, ban)).toBe(true);

    const justBan = withPermissionBit(both, kick, false);
    expect(hasPermissionBit(justBan, kick)).toBe(false);
    expect(hasPermissionBit(justBan, ban)).toBe(true);
  });

  it("turning off a bit that's already off changes nothing", () => {
    expect(withPermissionBit("0", kick, false)).toBe("0");
  });

  it("describes a role in plain language, ignoring bits it doesn't list", () => {
    expect(describePermissions("0")).toBe("No special permissions");
    expect(describePermissions(withPermissionBit(withPermissionBit("0", kick, true), ban, true))).toBe(
      "Kick members, Ban members"
    );
    // A bit this client has never heard of (say, one a newer server added) is ignored, not mislabelled.
    expect(describePermissions((1n << 40n).toString())).toBe("No special permissions");
    // The three bits that used to be defined-but-unenforced are named now that the server checks them.
    expect(describePermissions((1n << 8n).toString())).toBe("Add reactions");
    expect(describePermissions(((1n << 6n) | (1n << 3n)).toString())).toBe("Delete messages, Manage emoticons");
  });
});
