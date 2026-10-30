// The permissions a role can grant. The bit values mirror
// server/src/lib/permissions.ts - permissions.test.ts fails if they drift, and also
// fails if the server defines a bit that isn't offered here, so a new permission can't
// be added without deciding what it does. Only offer a bit the server enforces: a
// checkbox that does nothing would just mislead (MANAGE_EMOTICONS, DELETE_MESSAGES and
// REACT were left out for exactly that reason until the server started checking them).
export interface PermissionDef {
  key: string;
  bit: bigint;
  label: string;
  description: string;
}

export const ROLE_PERMISSIONS: PermissionDef[] = [
  { key: "SEND_MESSAGES", bit: 1n << 7n, label: "Send messages", description: "Post in the community's channels" },
  { key: "REACT", bit: 1n << 8n, label: "Add reactions", description: "React to messages (taking back your own reaction is always allowed)" },
  { key: "DELETE_MESSAGES", bit: 1n << 6n, label: "Delete messages", description: "Delete other members' messages in the community's channels" },
  { key: "MANAGE_EMOTICONS", bit: 1n << 3n, label: "Manage emoticons", description: "Edit and delete the community's emoticons, whoever created them" },
  { key: "KICK_MEMBERS", bit: 1n << 4n, label: "Kick members", description: "Remove a member (they can rejoin)" },
  { key: "BAN_MEMBERS", bit: 1n << 5n, label: "Ban members", description: "Ban and unban members" },
  { key: "MANAGE_CHANNELS", bit: 1n << 2n, label: "Manage channels", description: "Create, rename, reorder and delete channels" },
  { key: "MANAGE_ROLES", bit: 1n << 1n, label: "Manage roles", description: "Create roles and assign them - only up to the permissions they hold themselves" },
  { key: "CREATE_INVITE", bit: 1n << 9n, label: "Create invites", description: "Make invite codes, and send invitations to friends" },
  { key: "CONNECT_VOICE", bit: 1n << 10n, label: "Connect to voice channels", description: "Join a voice channel and talk" },
  { key: "REVIEW_REPORTS", bit: 1n << 11n, label: "Review reports", description: "See the reports members make about messages and the community, and close them" },
  { key: "MANAGE_COMMUNITY", bit: 1n << 0n, label: "Manage community", description: "Change the community's name and description" },
];

export function hasPermissionBit(permissions: string, bit: bigint): boolean {
  return (BigInt(permissions) & bit) === bit;
}

export function withPermissionBit(permissions: string, bit: bigint, on: boolean): string {
  const current = BigInt(permissions);
  return (on ? current | bit : current & ~bit).toString();
}

// Plain-language list for a role's row, e.g. "Kick members, Ban members".
export function describePermissions(permissions: string): string {
  const names = ROLE_PERMISSIONS.filter((p) => hasPermissionBit(permissions, p.bit)).map((p) => p.label);
  return names.length > 0 ? names.join(", ") : "No special permissions";
}

/** Every permission the server defines (permissions.test.ts keeps ROLE_PERMISSIONS complete). */
export const ALL_PERMISSION_BITS = ROLE_PERMISSIONS.reduce((all, p) => all | p.bit, 0n);

// The slice of a community these helpers read, so they can be tested without a full payload.
interface CommunityPermissionData {
  owner: { id: string; identity: string };
  roles: { id: string; permissions: string }[];
  members: { id: string; roleIds: string[] }[];
}

/**
 * What the viewer may do in this community, worked out the way the server does it: the
 * owner holds everything, anyone else holds the union of their roles (@everyone is one of
 * them). Only for deciding which controls to show - the server still checks every request.
 */
export function viewerPermissions(community: CommunityPermissionData, viewer: { id: string }): bigint {
  if (community.owner.id === viewer.id) return ALL_PERMISSION_BITS;
  const member = community.members.find((m) => m.id === viewer.id);
  if (!member) return 0n;
  return community.roles
    .filter((role) => member.roleIds.includes(role.id))
    .reduce((all, role) => all | BigInt(role.permissions), 0n);
}

/** True if every bit of `rolePermissions` is one the actor holds (the server's rule for editing or giving a role). */
export function permissionsWithin(actor: bigint, rolePermissions: string): boolean {
  return (BigInt(rolePermissions) & ~actor) === 0n;
}

/** The server part of an identity such as "@alex:chat.example". */
export function domainOf(identity: string): string {
  return identity.slice(identity.indexOf(":") + 1).toLowerCase();
}

export interface ManagementAccess {
  general: boolean;
  /** Role chips on the Members tab. */
  roles: boolean;
  kick: boolean;
  ban: boolean;
  channels: boolean;
  /** The Members tab: kicking, banning or giving roles. */
  members: boolean;
  /** The Reports tab (#58): reading and closing the reports made about messages in the community. */
  reports: boolean;
  /** Whether the Settings button should be shown at all. */
  any: boolean;
}

/**
 * Which parts of community settings the viewer can use. A community hosted on another
 * server can't be managed from here (the server refuses with 409), so only a local
 * community - one whose owner is on the viewer's own server - gets any controls; the
 * owner always does.
 */
export function managementAccess(community: CommunityPermissionData, viewer: { id: string; identity: string }): ManagementAccess {
  const isOwner = community.owner.id === viewer.id;
  const local = isOwner || domainOf(community.owner.identity) === domainOf(viewer.identity);
  const perms = local ? viewerPermissions(community, viewer) : 0n;
  const has = (key: string) => {
    const bit = ROLE_PERMISSIONS.find((p) => p.key === key)!.bit;
    return (perms & bit) === bit;
  };
  const access = {
    general: has("MANAGE_COMMUNITY"),
    roles: has("MANAGE_ROLES"),
    kick: has("KICK_MEMBERS"),
    ban: has("BAN_MEMBERS"),
    channels: has("MANAGE_CHANNELS"),
    reports: has("REVIEW_REPORTS"),
  };
  const members = access.kick || access.ban || access.roles;
  return { ...access, members, any: access.general || access.channels || members || access.reports };
}

/**
 * Whether the viewer may make invites in this community: the CREATE_INVITE permission, which everyone has until a manager
 * takes it away from the @everyone role. Only meaningful where the roles are known, which is on the community's home server:
 * a community on another server is cached without its roles, so this would say no to everyone there. For those the home
 * server decides, and the client asks it.
 */
export function canCreateInvites(community: CommunityPermissionData, viewer: { id: string }): boolean {
  const bit = ROLE_PERMISSIONS.find((p) => p.key === "CREATE_INVITE")!.bit;
  return (viewerPermissions(community, viewer) & bit) === bit;
}
