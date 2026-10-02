export const Permission = {
  MANAGE_COMMUNITY: 1n << 0n,
  MANAGE_ROLES: 1n << 1n,
  MANAGE_CHANNELS: 1n << 2n,
  MANAGE_EMOTICONS: 1n << 3n,
  KICK_MEMBERS: 1n << 4n,
  BAN_MEMBERS: 1n << 5n,
  DELETE_MESSAGES: 1n << 6n,
  SEND_MESSAGES: 1n << 7n,
  REACT: 1n << 8n,
} as const;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);
export const DEFAULT_MEMBER_PERMISSIONS = Permission.SEND_MESSAGES | Permission.REACT;

export function hasPermission(combinedPermissions: bigint, flag: bigint): boolean {
  return (combinedPermissions & flag) === flag;
}

export function combinePermissions(bitmasks: bigint[]): bigint {
  return bitmasks.reduce((acc, bits) => acc | bits, 0n);
}
