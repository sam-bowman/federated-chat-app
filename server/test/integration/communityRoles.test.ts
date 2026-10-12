// Role management: create/edit/delete/assign, and - the part that matters most -
// the rule that a non-owner can only deal in roles within their own permissions.
// Before that rule, anyone holding MANAGE_ROLES could mint a role with every
// permission and give it to themselves.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { ALL_PERMISSIONS, Permission } from "../../src/lib/permissions.js";
import { api } from "../helpers/app.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
const perms = (...bits: bigint[]) => bits.reduce((a, b) => a | b, 0n).toString();

async function createCommunity(owner: Registered, name = "Roles Test") {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community as { id: string; roles: { id: string; name: string; isDefault: boolean }[] };
}

async function join(community: { id: string }, user: Registered) {
  const res = await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken));
  expect(res.status).toBe(201);
}

const createRole = (token: string, communityId: string, body: object) =>
  api.post(`/api/v1/communities/${communityId}/roles`).set(authHeader(token)).send(body);
const patchRole = (token: string, communityId: string, roleId: string, body: object) =>
  api.patch(`/api/v1/communities/${communityId}/roles/${roleId}`).set(authHeader(token)).send(body);
const deleteRole = (token: string, communityId: string, roleId: string) =>
  api.delete(`/api/v1/communities/${communityId}/roles/${roleId}`).set(authHeader(token));
const assign = (token: string, communityId: string, userId: string, roleId: string) =>
  api.post(`/api/v1/communities/${communityId}/members/${userId}/roles/${roleId}`).set(authHeader(token));
const unassign = (token: string, communityId: string, userId: string, roleId: string) =>
  api.delete(`/api/v1/communities/${communityId}/members/${userId}/roles/${roleId}`).set(authHeader(token));

async function getMember(token: string, community: { id: string }, userId: string) {
  const res = await api.get(`/api/v1/communities/${community.id}`).set(authHeader(token));
  return (res.body.community.members as { id: string; roleIds: string[] }[]).find((m) => m.id === userId)!;
}

describe("creating and assigning roles", () => {
  it("lets the owner create a role, assign it, and the member's permissions really change", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    await join(community, bob);
    await join(community, carol);

    const role = await createRole(alice.accessToken, community.id, {
      name: "Moderator",
      color: "#ff8800",
      permissions: perms(Permission.KICK_MEMBERS),
    });
    expect(role.status).toBe(201);
    expect(role.body.role).toMatchObject({ name: "Moderator", color: "#ff8800", isDefault: false });
    expect(role.body.role.permissions).toBe(perms(Permission.KICK_MEMBERS));

    // Before: bob can't kick.
    expect(
      (await api.delete(`/api/v1/communities/${community.id}/members/${carol.user.id}`).set(authHeader(bob.accessToken))).status
    ).toBe(403);

    expect((await assign(alice.accessToken, community.id, bob.user.id, role.body.role.id)).status).toBe(204);
    expect((await getMember(alice.accessToken, community, bob.user.id)).roleIds).toContain(role.body.role.id);

    // After: he can.
    expect(
      (await api.delete(`/api/v1/communities/${community.id}/members/${carol.user.id}`).set(authHeader(bob.accessToken))).status
    ).toBe(204);
  });

  it("unassigning takes the ability away again", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    await join(community, bob);
    await join(community, carol);
    const role = (await createRole(alice.accessToken, community.id, { name: "Mod", permissions: perms(Permission.KICK_MEMBERS) })).body.role;
    await assign(alice.accessToken, community.id, bob.user.id, role.id);

    expect((await unassign(alice.accessToken, community.id, bob.user.id, role.id)).status).toBe(204);

    expect((await getMember(alice.accessToken, community, bob.user.id)).roleIds).not.toContain(role.id);
    expect(
      (await api.delete(`/api/v1/communities/${community.id}/members/${carol.user.id}`).set(authHeader(bob.accessToken))).status
    ).toBe(403);
  });

  it("rejects malformed input with a 400 rather than a server error", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const make = (body: object) => createRole(alice.accessToken, community.id, body);

    expect((await make({ name: "x", permissions: "abc" })).status).toBe(400);
    expect((await make({ name: "x", permissions: "-1" })).status).toBe(400);
    expect((await make({ name: "x", permissions: (1n << 40n).toString() })).status).toBe(400); // a bit no permission defines
    expect((await make({ name: "x", color: "red" })).status).toBe(400);
    expect((await make({ name: "" })).status).toBe(400);
    expect((await make({ name: "ok", permissions: perms(Permission.SEND_MESSAGES), color: "#00ff00" })).status).toBe(201);
  });

  it("refuses everything to a member without MANAGE_ROLES", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);
    const role = (await createRole(alice.accessToken, community.id, { name: "R" })).body.role;

    expect((await createRole(bob.accessToken, community.id, { name: "x" })).status).toBe(403);
    expect((await patchRole(bob.accessToken, community.id, role.id, { name: "y" })).status).toBe(403);
    expect((await deleteRole(bob.accessToken, community.id, role.id)).status).toBe(403);
    expect((await assign(bob.accessToken, community.id, bob.user.id, role.id)).status).toBe(403);
  });

  it("tells every local member to refresh, so changes show up live", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(community, bob);
    const bobRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: bob.user.id } });
    const count = () => prisma.syncEvent.count({ where: { recipientId: bobRow.id, type: "community:updated" } });
    const before = await count();

    await createRole(alice.accessToken, community.id, { name: "Fresh" });

    expect(await count()).toBe(before + 1);
  });
});

// The regression for the escalation: a delegated role manager must not be able
// to grant, assign, edit or remove anything beyond their own permissions.
describe("a delegated role manager can't escalate", () => {
  async function setup() {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    await join(community, bob);
    await join(community, carol);
    const managerRole = (
      await createRole(alice.accessToken, community.id, {
        name: "Role Manager",
        permissions: perms(Permission.MANAGE_ROLES, Permission.KICK_MEMBERS),
      })
    ).body.role;
    await assign(alice.accessToken, community.id, bob.user.id, managerRole.id);
    const adminRole = (
      await createRole(alice.accessToken, community.id, {
        name: "Admin",
        permissions: perms(Permission.MANAGE_COMMUNITY, Permission.BAN_MEMBERS),
      })
    ).body.role;
    return { alice, bob, carol, community, managerRole, adminRole };
  }

  it("can create roles within their own permissions, but not beyond them", async () => {
    const { bob, community } = await setup();

    expect((await createRole(bob.accessToken, community.id, { name: "Kicker", permissions: perms(Permission.KICK_MEMBERS) })).status).toBe(201);

    const beyond = await createRole(bob.accessToken, community.id, { name: "Sneaky", permissions: perms(Permission.MANAGE_COMMUNITY) });
    expect(beyond.status).toBe(403);
    expect(beyond.body.error).toBe("role_exceeds_your_permissions");

    // The exact attack: a role with everything, to give to themselves.
    expect((await createRole(bob.accessToken, community.id, { name: "God", permissions: ALL_PERMISSIONS.toString() })).status).toBe(403);
  });

  it("can't assign themselves (or anyone) a more powerful role", async () => {
    const { bob, carol, community, adminRole } = await setup();

    expect((await assign(bob.accessToken, community.id, bob.user.id, adminRole.id)).status).toBe(403);
    expect((await assign(bob.accessToken, community.id, carol.user.id, adminRole.id)).status).toBe(403);
    expect((await getMember(bob.accessToken, community, bob.user.id)).roleIds).not.toContain(adminRole.id);
  });

  it("can't edit, delete, or strip a role more powerful than their own", async () => {
    const { alice, bob, carol, community, adminRole } = await setup();
    await assign(alice.accessToken, community.id, carol.user.id, adminRole.id);

    expect((await patchRole(bob.accessToken, community.id, adminRole.id, { name: "Renamed" })).status).toBe(403);
    expect((await deleteRole(bob.accessToken, community.id, adminRole.id)).status).toBe(403);
    expect((await unassign(bob.accessToken, community.id, carol.user.id, adminRole.id)).status).toBe(403);
    expect((await getMember(alice.accessToken, community, carol.user.id)).roleIds).toContain(adminRole.id);
  });

  it("can't raise a role - even their own - past what they hold", async () => {
    const { bob, community, managerRole } = await setup();

    const raise = await patchRole(bob.accessToken, community.id, managerRole.id, {
      permissions: perms(Permission.MANAGE_ROLES, Permission.KICK_MEMBERS, Permission.BAN_MEMBERS),
    });
    expect(raise.status).toBe(403);

    // Lowering or renaming is fine.
    const lower = await patchRole(bob.accessToken, community.id, managerRole.id, { name: "Role Manager 2" });
    expect(lower.status).toBe(200);
  });

  it("can still assign and remove roles within their own permissions", async () => {
    const { alice, bob, carol, community } = await setup();
    const kicker = (await createRole(alice.accessToken, community.id, { name: "Kicker", permissions: perms(Permission.KICK_MEMBERS) })).body.role;

    expect((await assign(bob.accessToken, community.id, carol.user.id, kicker.id)).status).toBe(204);
    expect((await unassign(bob.accessToken, community.id, carol.user.id, kicker.id)).status).toBe(204);
  });
});

describe("a role belongs to one community", () => {
  it("rejects a role id from another community, however it's reached", async () => {
    const alice = await registerUser("alice");
    const dave = await registerUser("dave");
    const bob = await registerUser("bob");
    const mine = await createCommunity(alice, "Mine");
    const theirs = await createCommunity(dave, "Theirs");
    await join(mine, bob);
    const foreignRole = (await createRole(dave.accessToken, theirs.id, { name: "Foreign", permissions: perms(Permission.BAN_MEMBERS) })).body.role;

    // Alice owns "Mine" and may manage roles there - but not borrow Dave's.
    const attach = await assign(alice.accessToken, mine.id, bob.user.id, foreignRole.id);
    expect(attach.status).toBe(404);
    expect(attach.body.error).toBe("role_not_found");
    expect((await unassign(alice.accessToken, mine.id, bob.user.id, foreignRole.id)).status).toBe(404);
    expect((await patchRole(alice.accessToken, mine.id, foreignRole.id, { name: "Hijacked" })).status).toBe(404);
    expect((await deleteRole(alice.accessToken, mine.id, foreignRole.id)).status).toBe(404);

    const stored = await prisma.role.findUniqueOrThrow({ where: { id: foreignRole.id } });
    expect(stored.name).toBe("Foreign");
    expect(await prisma.memberRole.count({ where: { roleId: foreignRole.id } })).toBe(0);
  });
});

describe("editing and deleting", () => {
  it("edits name, colour and permissions, and clears a colour with null", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const role = (await createRole(alice.accessToken, community.id, { name: "Old", color: "#112233" })).body.role;

    const edited = await patchRole(alice.accessToken, community.id, role.id, {
      name: "New",
      color: "#445566",
      permissions: perms(Permission.SEND_MESSAGES, Permission.BAN_MEMBERS),
    });
    expect(edited.status).toBe(200);
    expect(edited.body.role).toMatchObject({ name: "New", color: "#445566", permissions: perms(Permission.SEND_MESSAGES, Permission.BAN_MEMBERS) });

    const cleared = await patchRole(alice.accessToken, community.id, role.id, { color: null });
    expect(cleared.body.role.color).toBeNull();
    expect(cleared.body.role.name).toBe("New");
  });

  it("rejects an empty or invalid edit and 404s an unknown role", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const role = (await createRole(alice.accessToken, community.id, { name: "R" })).body.role;

    expect((await patchRole(alice.accessToken, community.id, role.id, {})).status).toBe(400);
    expect((await patchRole(alice.accessToken, community.id, role.id, { permissions: "nope" })).status).toBe(400);
    expect((await patchRole(alice.accessToken, community.id, "no-such-role", { name: "x" })).status).toBe(404);
  });

  it("deleting a role removes it from the community and from every member who had it", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const community = await createCommunity(alice);
    await join(community, bob);
    await join(community, carol);
    const role = (await createRole(alice.accessToken, community.id, { name: "Mod", permissions: perms(Permission.KICK_MEMBERS) })).body.role;
    await assign(alice.accessToken, community.id, bob.user.id, role.id);

    expect((await deleteRole(alice.accessToken, community.id, role.id)).status).toBe(204);

    const fetched = await api.get(`/api/v1/communities/${community.id}`).set(authHeader(alice.accessToken));
    expect(fetched.body.community.roles.map((r: { id: string }) => r.id)).not.toContain(role.id);
    expect((await getMember(alice.accessToken, community, bob.user.id)).roleIds).not.toContain(role.id);
    // ...and with it, the ability it gave.
    expect(
      (await api.delete(`/api/v1/communities/${community.id}/members/${carol.user.id}`).set(authHeader(bob.accessToken))).status
    ).toBe(403);
  });

  it("protects @everyone: it can't be deleted or renamed, but its permissions can change", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const everyone = community.roles.find((r) => r.isDefault)!;

    const del = await deleteRole(alice.accessToken, community.id, everyone.id);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe("cannot_delete_default_role");

    const rename = await patchRole(alice.accessToken, community.id, everyone.id, { name: "everybody" });
    expect(rename.status).toBe(400);
    expect(rename.body.error).toBe("cannot_rename_default_role");

    const tweak = await patchRole(alice.accessToken, community.id, everyone.id, { name: everyone.name, permissions: perms(Permission.SEND_MESSAGES) });
    expect(tweak.status).toBe(200);
    expect(tweak.body.role.permissions).toBe(perms(Permission.SEND_MESSAGES));
  });
});

describe("a community hosted on another server", () => {
  it("can't have its roles managed from here", async () => {
    const alice = await registerUser("alice");
    const aliceRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const remoteOwner = await prisma.user.create({
      data: { protocolId: "REMOTEOWNERID012345", username: "remote-owner", displayName: "R", homeserverDomain: "home.invalid", isRemote: true },
    });
    const remote = await prisma.community.create({
      data: { protocolId: "REMOTECOMMUNITYID01", name: "Remote", ownerId: remoteOwner.id, homeserverDomain: "home.invalid", isRemote: true },
    });
    await prisma.communityMember.create({ data: { communityId: remote.id, userId: aliceRow.id } });

    expect((await createRole(alice.accessToken, remote.protocolId, { name: "x" })).status).toBe(409);
    expect((await patchRole(alice.accessToken, remote.protocolId, "any", { name: "x" })).status).toBe(409);
    expect((await deleteRole(alice.accessToken, remote.protocolId, "any")).status).toBe(409);
  });
});
