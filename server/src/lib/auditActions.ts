// Every kind of thing the audit log (#59) records, by a stable name. Adding an action means adding it here, so the admin page can offer it as a
// filter and a test can check that nothing writes a name this list does not know.

/** Done inside a community, by someone who manages it (or by the moderators' own permissions). */
export const COMMUNITY_ACTIONS = [
  "community.update",
  "community.transfer",
  "community.delete",
  "member.kick",
  "member.ban",
  "member.unban",
  "member.role.add",
  "member.role.remove",
  "role.create",
  "role.update",
  "role.delete",
  "channel.create",
  "channel.update",
  "channel.delete",
  "message.delete",
  "report.resolve",
  "report.dismiss",
  "report.reopen",
] as const;

/** Done to an account or to the server by the operator, the admin page or the system. */
export const SERVER_ACTIONS = [
  "account.delete_request",
  "account.delete_cancel",
  "account.erase",
  "user.suspend",
  "user.unsuspend",
  "user.reset_password",
  "user.disable_2fa",
  "user.admin_grant",
  "user.admin_revoke",
  "registration_invite.create",
  "registration_invite.revoke",
  "setting.change",
] as const;

export const AUDIT_ACTIONS = [...COMMUNITY_ACTIONS, ...SERVER_ACTIONS] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_SOURCES = ["api", "admin", "cli", "system"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);
}
export function isAuditSource(value: unknown): value is AuditSource {
  return typeof value === "string" && (AUDIT_SOURCES as readonly string[]).includes(value);
}
