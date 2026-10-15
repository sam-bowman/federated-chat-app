import { describe, expect, it } from "vitest";
// Read as plain text (Vite's ?raw) rather than via node:fs - this folder is
// browser-scoped (tsconfig.app.json deliberately has no Node types).
import serverSource from "../../../server/src/lib/permissions.ts?raw";
import {
  ALL_PERMISSION_BITS,
  ROLE_PERMISSIONS,
  canCreateInvites,
  describePermissions,
  hasPermissionBit,
  managementAccess,
  permissionsWithin,
  viewerPermissions,
  withPermissionBit,
} from "./permissions";

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

describe("what a viewer can do", () => {
  const bit = (key: string) => ROLE_PERMISSIONS.find((p) => p.key === key)!.bit;
  const role = (id: string, ...keys: string[]) => ({
    id,
    permissions: keys.reduce((all, k) => all | bit(k), 0n).toString(),
  });

  const owner = { id: "owner", identity: "@owner:chat.example" };
  const community = {
    owner,
    roles: [
      role("every", "SEND_MESSAGES", "REACT"),
      role("mod", "KICK_MEMBERS"),
      role("banner", "BAN_MEMBERS"),
      role("admin", "MANAGE_ROLES", "MANAGE_CHANNELS", "MANAGE_COMMUNITY"),
    ],
    members: [
      { id: "owner", roleIds: ["every"] },
      { id: "plain", roleIds: ["every"] },
      { id: "kicker", roleIds: ["every", "mod"] },
      { id: "banner", roleIds: ["every", "banner"] },
      { id: "admin", roleIds: ["every", "admin"] },
      { id: "both", roleIds: ["every", "mod", "banner"] },
    ],
  };
  const viewer = (id: string, domain = "chat.example") => ({ id, identity: `@${id}:${domain}` });

  it("gives the owner every permission, whatever their roles say", () => {
    expect(viewerPermissions(community, owner)).toBe(ALL_PERMISSION_BITS);
  });

  it("gives anyone else the union of their roles, and nothing if they are not a member", () => {
    expect(viewerPermissions(community, { id: "both" })).toBe(bit("SEND_MESSAGES") | bit("REACT") | bit("KICK_MEMBERS") | bit("BAN_MEMBERS"));
    expect(viewerPermissions(community, { id: "stranger" })).toBe(0n);
  });

  it("covers every bit the server defines when the owner is asked", () => {
    for (const p of ROLE_PERMISSIONS) expect(viewerPermissions(community, owner) & p.bit).toBe(p.bit);
  });

  it("shows an ordinary member no management controls at all", () => {
    expect(managementAccess(community, viewer("plain"))).toEqual({
      general: false, roles: false, kick: false, ban: false, channels: false, members: false, any: false,
    });
  });

  it("gives the owner everything", () => {
    expect(managementAccess(community, owner)).toEqual({
      general: true, roles: true, kick: true, ban: true, channels: true, members: true, any: true,
    });
  });

  it("maps each permission to its own control", () => {
    expect(managementAccess(community, viewer("kicker"))).toMatchObject({ kick: true, ban: false, members: true, roles: false, general: false, channels: false, any: true });
    expect(managementAccess(community, viewer("banner"))).toMatchObject({ kick: false, ban: true, members: true, any: true });
    expect(managementAccess(community, viewer("admin"))).toMatchObject({ roles: true, channels: true, general: true, members: true, kick: false, ban: false });
  });

  it("does not offer another server's community, which the server would refuse", () => {
    const remote = { ...community, owner: { id: "far", identity: "@far:other.example" } };
    expect(managementAccess(remote, viewer("admin"))).toMatchObject({ any: false, roles: false, channels: false });
  });

  it("compares servers case-insensitively and by the whole domain, port included", () => {
    expect(managementAccess(community, viewer("admin", "CHAT.example")).any).toBe(true);
    const ported = { ...community, owner: { id: "owner", identity: "@owner:localhost:4000" } };
    expect(managementAccess(ported, viewer("admin", "localhost:4000")).any).toBe(true);
    expect(managementAccess(ported, viewer("admin", "localhost:4001")).any).toBe(false);
  });
});

describe("permissionsWithin", () => {
  it("accepts a role whose bits are all held, and refuses one with a bit that is not", () => {
    const held = (1n << 4n) | (1n << 7n);
    expect(permissionsWithin(held, (1n << 4n).toString())).toBe(true);
    expect(permissionsWithin(held, "0")).toBe(true);
    expect(permissionsWithin(held, ((1n << 4n) | (1n << 5n)).toString())).toBe(false);
  });
});

describe("canCreateInvites", () => {
  const owner = { id: "owner", identity: "@owner:chat.example" };
  const base = (everyone: string, memberRoleIds: string[] = ["every"]) => ({
    owner,
    roles: [{ id: "every", permissions: everyone }],
    members: [{ id: "owner", roleIds: [] as string[] }, { id: "bob", roleIds: memberRoleIds }],
  });
  const CREATE_INVITE = String(1 << 9);

  it("is true for the owner, whatever the roles say", () => {
    expect(canCreateInvites(base("0"), { id: "owner" })).toBe(true);
  });

  it("is true for a member whose roles include CREATE_INVITE, which @everyone has by default", () => {
    expect(canCreateInvites(base(String(128 + 256 + 512)), { id: "bob" })).toBe(true);
    expect(canCreateInvites(base(CREATE_INVITE), { id: "bob" })).toBe(true);
  });

  it("is false for a member whose roles lack it, and for someone who is not a member", () => {
    expect(canCreateInvites(base(String(128 + 256)), { id: "bob" })).toBe(false);
    expect(canCreateInvites(base(CREATE_INVITE), { id: "stranger" })).toBe(false);
    expect(canCreateInvites(base(CREATE_INVITE, []), { id: "bob" })).toBe(false);
  });

  // A community on another server is cached without its roles, so this cannot know and says no: the Invite dialog only
  // trusts it on the community's home server, and asks the home server otherwise.
  it("cannot tell where the roles are not known, and so says no", () => {
    const cached = { owner: { id: "olga", identity: "@olga:far.example" }, roles: [], members: [{ id: "bob", roleIds: [] as string[] }] };

    expect(canCreateInvites(cached, { id: "bob" })).toBe(false);
  });
});
