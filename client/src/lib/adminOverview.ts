import type { AdminOverview } from "../api";
import { VISIBILITY_CHOICES } from "./communityVisibility";

// What the admin page's Overview says, in words: the settings by name, their values, and what deserves a look. The numbers come from the server as
// they are; this only decides how they read. Kept apart from the component so each rule can be tested on its own.

/** What each setting is called on the page. The server sends the names of the environment variables; a test checks every one it sends has a label here. */
export const SETTING_LABELS: Record<string, string> = {
  ACCOUNT_DELETION_GRACE_DAYS: "Waiting period before a deleted account is erased",
  AUDIT_LOG_RETENTION_DAYS: "How long the audit log is kept",
  REPORT_RETENTION_DAYS: "How long reports are kept",
  COMMUNITY_VISIBILITY_DEFAULT: "Who can join a new community",
  COMMUNITY_VISIBILITY_LIMIT: "The most open a community may be",
  FEDERATION_CONTACT_POLICY_DEFAULT: "Who may start something with a new account",
  FEDERATION_CONTACT_POLICY_LIMIT: "The widest anyone may allow",
  FEDERATION_USER_DISCOVERABILITY: "Whether people can be found by other servers",
  DIRECTORY_PEOPLE: "Whether people are listed in the directory",
  MAX_UPLOAD_BYTES: "Largest file that can be uploaded",
};

// Said of the people on the server, not "I": this is a setting for everyone.
const CONTACT: Record<string, string> = {
  ANYONE: "Anyone",
  SHARED_COMMUNITY: "People who share a community with them",
  LOCAL_ONLY: "People on this server",
};

const DISCOVERABILITY: Record<string, string> = {
  "default-on": "Findable unless they hide",
  "default-off": "Hidden unless they choose to be found",
  "forced-off": "Nobody is findable",
};

const DIRECTORY_PEOPLE: Record<string, string> = {
  "default-off": "Listed only if they choose to be",
  "default-on": "Listed unless they opt out",
  "forced-off": "Nobody is listed",
};

/** A size in the units people think in. */
export function sizeInWords(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes >= 1024 * 1024 * 1024) return `${+(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${+(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/** A number of days, in words. 0 is what the setting says it is. */
const days = (value: string, zero: string) => (value === "0" ? zero : `${value} day${value === "1" ? "" : "s"}`);

/** What a setting's value reads as. A value it does not know is shown as it came, so nothing is hidden by a missing rule. */
export function settingValueInWords(setting: string, value: string): string {
  switch (setting) {
    case "ACCOUNT_DELETION_GRACE_DAYS":
      return days(value, "none: erased at the next hourly pass");
    case "AUDIT_LOG_RETENTION_DAYS":
    case "REPORT_RETENTION_DAYS":
      return days(value, "for ever");
    case "COMMUNITY_VISIBILITY_DEFAULT":
    case "COMMUNITY_VISIBILITY_LIMIT":
      return VISIBILITY_CHOICES.find((choice) => choice.value === value)?.label ?? value;
    case "FEDERATION_CONTACT_POLICY_DEFAULT":
    case "FEDERATION_CONTACT_POLICY_LIMIT":
      return CONTACT[value] ?? value;
    case "FEDERATION_USER_DISCOVERABILITY":
      return DISCOVERABILITY[value] ?? value;
    case "DIRECTORY_PEOPLE":
      return DIRECTORY_PEOPLE[value] ?? value;
    case "MAX_UPLOAD_BYTES":
      return sizeInWords(Number(value));
    default:
      return value;
  }
}

/** How long ago, roughly, in the units that matter for a queue: minutes, hours, days. */
export function agoInWords(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const daysAgo = Math.floor(hours / 24);
  return `${daysAgo} days ago`;
}

/** A waiting event this old is no longer "on its way": it is stuck. */
export const STUCK_AFTER_MS = 60 * 60 * 1000;

/** What is worth a look, as sentences: events other servers never got, and events that have waited too long. Nothing when all is well. */
export function attentionItems(overview: AdminOverview, now: Date): string[] {
  const items: string[] = [];
  const { queue } = overview.federation;
  if (queue.failed > 0) {
    items.push(
      `${queue.failed} message${queue.failed === 1 ? "" : "s"} for other servers gave up after too many tries and will not be sent again by themselves. The server they were for may be down or may have blocked this one.`
    );
  }
  if (queue.oldestPendingAt && now.getTime() - new Date(queue.oldestPendingAt).getTime() >= STUCK_AFTER_MS) {
    items.push(`Something for another server has been waiting since ${agoInWords(queue.oldestPendingAt, now)}. It keeps being retried: that server may be unreachable.`);
  }
  return items;
}
