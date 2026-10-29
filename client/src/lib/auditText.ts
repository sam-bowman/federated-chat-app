import type { AuditEntry } from "../api";

// How an audit log entry (#59) reads. Everything in an entry is text from the server (names and labels can be anything a person typed), so
// this only ever builds plain strings, which React draws as text and never as markup.

/** The actions the log knows, in the order the filter offers them, with how each reads in a list. The server's list is checked against this one. */
export const AUDIT_ACTION_OPTIONS: { value: string; label: string; scope: "community" | "server" }[] = [
  { value: "community.update", label: "Changed community settings", scope: "community" },
  { value: "community.transfer", label: "Handed over a community", scope: "community" },
  { value: "community.delete", label: "Deleted a community", scope: "community" },
  { value: "member.kick", label: "Removed a member", scope: "community" },
  { value: "member.ban", label: "Banned a member", scope: "community" },
  { value: "member.unban", label: "Unbanned a member", scope: "community" },
  { value: "member.role.add", label: "Gave a role", scope: "community" },
  { value: "member.role.remove", label: "Took a role away", scope: "community" },
  { value: "role.create", label: "Made a role", scope: "community" },
  { value: "role.update", label: "Changed a role", scope: "community" },
  { value: "role.delete", label: "Deleted a role", scope: "community" },
  { value: "channel.create", label: "Made a channel", scope: "community" },
  { value: "channel.update", label: "Changed a channel", scope: "community" },
  { value: "channel.delete", label: "Deleted a channel", scope: "community" },
  { value: "message.delete", label: "Removed someone's message", scope: "community" },
  { value: "report.resolve", label: "Resolved a report", scope: "community" },
  { value: "report.dismiss", label: "Dismissed a report", scope: "community" },
  { value: "report.reopen", label: "Reopened a report", scope: "community" },
  { value: "account.delete_request", label: "Asked for an account to be deleted", scope: "server" },
  { value: "account.delete_cancel", label: "Cancelled an account deletion", scope: "server" },
  { value: "account.erase", label: "Erased an account", scope: "server" },
  { value: "user.suspend", label: "Suspended an account", scope: "server" },
  { value: "user.unsuspend", label: "Unsuspended an account", scope: "server" },
  { value: "user.reset_password", label: "Reset a password", scope: "server" },
  { value: "user.disable_2fa", label: "Turned off two-factor sign-in", scope: "server" },
  { value: "user.admin_grant", label: "Made an admin", scope: "server" },
  { value: "user.admin_revoke", label: "Took admin away", scope: "server" },
  { value: "registration_invite.create", label: "Made a registration invite", scope: "server" },
  { value: "registration_invite.revoke", label: "Revoked a registration invite", scope: "server" },
  { value: "setting.change", label: "Changed a server setting", scope: "server" },
];

export const SOURCE_LABELS: Record<string, string> = {
  api: "in the app",
  admin: "on the admin page",
  cli: "from the command line",
  system: "by the server",
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const fields = (entry: AuditEntry): string => {
  const list = entry.details.fields;
  return Array.isArray(list) && list.length > 0 ? ` (${list.join(", ")})` : "";
};

/** One line saying what happened, who did it and to what. Falls back to the action's own name for one this client does not know. */
export function describeAudit(entry: AuditEntry): string {
  const who = entry.actor.label;
  const target = entry.target?.label ?? entry.target?.id ?? "something";
  const community = entry.community?.name ?? "the community";
  switch (entry.action) {
    case "community.update":
      return `${who} changed the settings of ${community}${fields(entry)}`;
    case "community.transfer":
      return `${who} handed ${community} to ${target}`;
    case "community.delete":
      return `${who} deleted the community ${target}`;
    case "member.kick":
      return `${who} removed ${target} from ${community}`;
    case "member.ban":
      return `${who} banned ${target} from ${community}`;
    case "member.unban":
      return `${who} unbanned ${target} in ${community}`;
    case "member.role.add":
      return `${who} gave ${target} the role ${text(entry.details.role) || "(unknown)"}`;
    case "member.role.remove":
      return `${who} took the role ${text(entry.details.role) || "(unknown)"} from ${target}`;
    case "role.create":
      return `${who} made the role ${target}`;
    case "role.update":
      return `${who} changed the role ${target}${fields(entry)}`;
    case "role.delete":
      return `${who} deleted the role ${target}`;
    case "channel.create":
      return `${who} made the channel ${target}`;
    case "channel.update":
      return `${who} changed the channel ${target}${fields(entry)}`;
    case "channel.delete":
      return `${who} deleted the channel ${target}`;
    case "message.delete":
      return `${who} removed someone's message${text(entry.details.channel) ? ` in ${text(entry.details.channel)}` : ""}`;
    case "report.resolve":
      return `${who} resolved ${target}`;
    case "report.dismiss":
      return `${who} dismissed ${target}`;
    case "report.reopen":
      return `${who} reopened ${target}`;
    case "account.delete_request":
      return `${who} asked for ${target} to be deleted`;
    case "account.delete_cancel":
      return `${who} cancelled the deletion of ${target}`;
    case "account.erase":
      return `${who} erased the account ${target}`;
    case "user.suspend":
      return `${who} suspended ${target}`;
    case "user.unsuspend":
      return `${who} unsuspended ${target}`;
    case "user.reset_password":
      return `${who} reset the password of ${target}`;
    case "user.disable_2fa":
      return `${who} turned off two-factor sign-in for ${target}`;
    case "user.admin_grant":
      return `${who} made ${target} an admin`;
    case "user.admin_revoke":
      return `${who} took admin away from ${target}`;
    case "registration_invite.create":
      return `${who} made a registration invite${entry.target?.label ? ` (${entry.target.label})` : ""}`;
    case "registration_invite.revoke":
      return `${who} revoked a registration invite${entry.target?.label ? ` (${entry.target.label})` : ""}`;
    case "setting.change":
      return `${who} changed the setting ${target}`;
    default:
      return `${who} did ${entry.action}`;
  }
}
