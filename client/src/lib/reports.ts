import type { Report, ReportKind, ReportReason, ResolveAction } from "../api";
import { ApiError } from "../api/client";

// Words for reporting (#58). The server's lists are the truth: reports.test.ts reads its source and fails if these drift.

export const REPORT_REASON_OPTIONS: { value: ReportReason; label: string; hint: string }[] = [
  { value: "spam", label: "Spam", hint: "Ads, scams or the same thing posted over and over" },
  { value: "harassment", label: "Harassment", hint: "Bullying, threats or targeting a person" },
  { value: "hate", label: "Hateful content", hint: "Attacking people for who they are" },
  { value: "illegal", label: "Illegal content", hint: "Something that breaks the law" },
  { value: "sexual", label: "Sexual content", hint: "Explicit material where it does not belong" },
  { value: "impersonation", label: "Impersonation", hint: "Pretending to be someone else" },
  { value: "other", label: "Something else", hint: "Anything else a moderator should look at" },
];

/** `label` is what the reviewer picks from; `done` is how the closed report then reads to everyone. */
export const RESOLVE_ACTION_OPTIONS: { value: ResolveAction; label: string; done: string }[] = [
  { value: "none", label: "Looked into it, nothing more needed", done: "nothing more needed" },
  { value: "message_deleted", label: "I deleted the message", done: "message deleted" },
  { value: "member_kicked", label: "I removed the member", done: "member removed" },
  { value: "member_banned", label: "I banned the member", done: "member banned" },
  { value: "account_suspended", label: "The account was suspended", done: "account suspended" },
  { value: "community_changed", label: "The community was changed", done: "community changed" },
  { value: "other", label: "Something else was done", done: "something else was done" },
];

export const MAX_DETAILS = 500;
export const MAX_NOTE = 500;

export const reasonLabel = (reason: string): string => REPORT_REASON_OPTIONS.find((o) => o.value === reason)?.label ?? reason;
export const actionLabel = (action: string | null): string => RESOLVE_ACTION_OPTIONS.find((o) => o.value === action)?.label ?? (action ?? "");
const actionDone = (action: string): string => RESOLVE_ACTION_OPTIONS.find((o) => o.value === action)?.done ?? action;

const KIND_LABELS: Record<ReportKind, string> = { message: "a message", user: "a person", community: "a community" };
export const kindLabel = (kind: ReportKind): string => KIND_LABELS[kind] ?? kind;

/** The title of the dialog that reports this kind of thing. */
export const reportTitle = (kind: ReportKind): string => `Report ${kindLabel(kind)}`;

/**
 * What to tell the person who tried to report, from the server's answer. A thing they cannot see looks like one that does not exist
 * (the server says the same for both), so the words cover both.
 */
export function reportFailureMessage(err: unknown, kind: ReportKind, domain?: string): string {
  if (!(err instanceof ApiError)) return "Couldn't send the report. Check your connection and try again.";
  const code = (err.body as { error?: string } | null)?.error;
  switch (code) {
    case "remote_community":
      return `This is on another server${domain ? ` (${domain})` : ""}, and nobody here can act on it. Report it to that server's moderators instead.`;
    case "already_reported":
      return `You have already reported this ${kind === "message" ? "message" : kind === "user" ? "person" : "community"}. A moderator will look at it.`;
    case "too_many_reports":
      return "You have sent a lot of reports. Wait a while, or until some of them have been looked at, and try again.";
    case "cannot_report_self":
      return "You can't report yourself.";
    case "not_found":
      return `That ${kind === "message" ? "message" : kind === "user" ? "person" : "community"} isn't available to report any more.`;
    default:
      return "Couldn't send the report. Try again in a moment.";
  }
}

/** Who a closed report was closed by and how, in a line. */
export function resolutionLine(report: Report): string | null {
  if (!report.resolution) return null;
  const how = report.status === "dismissed" ? "Dismissed" : report.resolution.action ? `Resolved (${actionDone(report.resolution.action)})` : "Resolved";
  return `${how}${report.resolution.by ? ` by ${report.resolution.by}` : ""}`;
}

/** The reporter's history, in words a moderator can weigh: "3 reports here, 1 dismissed". */
export function historyLine(history: Report["reporter"]["history"], inCommunity: boolean): string | null {
  if (!history) return null;
  const place = inCommunity ? "in this community" : "on this server";
  const reports = `${history.total} report${history.total === 1 ? "" : "s"} ${place}`;
  return history.dismissed > 0 ? `${reports}, ${history.dismissed} dismissed` : reports;
}
