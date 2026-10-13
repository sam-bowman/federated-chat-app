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
