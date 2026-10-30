import { describe, expect, it } from "vitest";
import serverOverview from "../../../server/src/modules/admin/overview.ts?raw";
import type { AdminOverview } from "../api";
import { SETTING_LABELS, STUCK_AFTER_MS, agoInWords, attentionItems, settingValueInWords, sizeInWords } from "./adminOverview";

const overview = (queue: Partial<AdminOverview["federation"]["queue"]> = {}): AdminOverview => ({
  generatedAt: "2026-06-01T12:00:00.000Z",
  server: { name: "S", domain: "s.example", version: "1.0.0", storage: "disk", redis: false },
  registration: { enabled: true, inviteOnly: false, activeInvites: 0 },
  features: { federation: true, voice: false, directory: false, linkPreviews: false },
  federation: { enabled: true, allowedServers: 0, blockedServers: 0, knownServers: 0, queue: { pending: 0, retrying: 0, inProgress: 0, failed: 0, oldestPendingAt: null, ...queue } },
  people: { total: 0, activeLastDay: 0, activeLastWeek: 0, activeLastMonth: 0, joinedLastWeek: 0, suspended: 0, deletionPending: 0, admins: 0, withoutTwoFactor: 0 },
  communities: { hosted: 0, copiesOfOthers: 0, memberships: 0, textChannels: 0, voiceChannels: 0, byVisibility: { UNLISTED: 0, PUBLIC: 0, INVITE_ONLY: 0, LOCAL_ONLY: 0 } },
  auditEntriesLastDay: 0,
  settings: [],
});
const NOW = new Date("2026-06-01T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

describe("SETTING_LABELS", () => {
  it("names every setting the server sends, and nothing it does not", () => {
    const sent = [...serverOverview.matchAll(/setting: "([A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect(sent.length).toBeGreaterThan(5);
    expect(Object.keys(SETTING_LABELS).sort()).toEqual(sent);
  });
});

describe("settingValueInWords", () => {
  it("says days as days, and what 0 means for each", () => {
    expect(settingValueInWords("ACCOUNT_DELETION_GRACE_DAYS", "14")).toBe("14 days");
    expect(settingValueInWords("ACCOUNT_DELETION_GRACE_DAYS", "1")).toBe("1 day");
    expect(settingValueInWords("ACCOUNT_DELETION_GRACE_DAYS", "0")).toBe("none: erased at the next hourly pass");
    expect(settingValueInWords("AUDIT_LOG_RETENTION_DAYS", "365")).toBe("365 days");
    expect(settingValueInWords("AUDIT_LOG_RETENTION_DAYS", "0")).toBe("for ever");
    expect(settingValueInWords("REPORT_RETENTION_DAYS", "180")).toBe("180 days");
    expect(settingValueInWords("REPORT_RETENTION_DAYS", "0")).toBe("for ever");
  });

  it("says who can join a community in the words Settings uses", () => {
    expect(settingValueInWords("COMMUNITY_VISIBILITY_DEFAULT", "UNLISTED")).toBe("Anyone with the community code");
    expect(settingValueInWords("COMMUNITY_VISIBILITY_LIMIT", "PUBLIC")).toBe("Public: listed in the directory");
    expect(settingValueInWords("COMMUNITY_VISIBILITY_LIMIT", "LOCAL_ONLY")).toBe("Only people on this server");
  });

  it("says who may start something with people about the people on the server, never as 'I'", () => {
    expect(settingValueInWords("FEDERATION_CONTACT_POLICY_DEFAULT", "ANYONE")).toBe("Anyone");
    expect(settingValueInWords("FEDERATION_CONTACT_POLICY_LIMIT", "SHARED_COMMUNITY")).toBe("People who share a community with them");
    expect(settingValueInWords("FEDERATION_CONTACT_POLICY_LIMIT", "LOCAL_ONLY")).toBe("People on this server");
  });

  it("says whether people can be found, and listed", () => {
    expect(settingValueInWords("FEDERATION_USER_DISCOVERABILITY", "default-on")).toBe("Findable unless they hide");
    expect(settingValueInWords("FEDERATION_USER_DISCOVERABILITY", "default-off")).toBe("Hidden unless they choose to be found");
    expect(settingValueInWords("FEDERATION_USER_DISCOVERABILITY", "forced-off")).toBe("Nobody is findable");
    expect(settingValueInWords("DIRECTORY_PEOPLE", "default-off")).toBe("Listed only if they choose to be");
    expect(settingValueInWords("DIRECTORY_PEOPLE", "default-on")).toBe("Listed unless they opt out");
    expect(settingValueInWords("DIRECTORY_PEOPLE", "forced-off")).toBe("Nobody is listed");
  });

  it("says the upload size in a size", () => {
    expect(settingValueInWords("MAX_UPLOAD_BYTES", String(8 * 1024 * 1024))).toBe("8 MB");
  });

  it("shows a value it has no words for as it came, so nothing is hidden", () => {
    expect(settingValueInWords("FEDERATION_USER_DISCOVERABILITY", "something-new")).toBe("something-new");
    expect(settingValueInWords("COMMUNITY_VISIBILITY_LIMIT", "SECRET_ONLY")).toBe("SECRET_ONLY");
    expect(settingValueInWords("A_NEW_SETTING", "42")).toBe("42");
  });
});

describe("sizeInWords", () => {
  it("uses the unit people think in", () => {
    expect(sizeInWords(500)).toBe("500 bytes");
    expect(sizeInWords(1024)).toBe("1 KB");
    expect(sizeInWords(1536)).toBe("1.5 KB");
    expect(sizeInWords(8 * 1024 * 1024)).toBe("8 MB");
    expect(sizeInWords(25 * 1024 * 1024)).toBe("25 MB");
    expect(sizeInWords(2 * 1024 ** 3)).toBe("2 GB");
  });

  it("does not make up a size for what is not one", () => {
    expect(sizeInWords(Number.NaN)).toBe("NaN");
    expect(sizeInWords(-5)).toBe("-5");
  });
});

describe("agoInWords", () => {
  it("says minutes, then hours, then days", () => {
    expect(agoInWords(minutesAgo(0), NOW)).toBe("less than a minute ago");
    expect(agoInWords(minutesAgo(1), NOW)).toBe("1 minute ago");
    expect(agoInWords(minutesAgo(59), NOW)).toBe("59 minutes ago");
    expect(agoInWords(minutesAgo(60), NOW)).toBe("1 hour ago");
    expect(agoInWords(minutesAgo(5 * 60), NOW)).toBe("5 hours ago");
    expect(agoInWords(minutesAgo(47 * 60), NOW)).toBe("47 hours ago");
    expect(agoInWords(minutesAgo(72 * 60), NOW)).toBe("3 days ago");
  });

  it("does not say a time in the future is in the past", () => {
    expect(agoInWords(minutesAgo(-30), NOW)).toBe("less than a minute ago");
  });
});

describe("attentionItems", () => {
  it("is empty when nothing is waiting, or when what is waiting is recent", () => {
    expect(attentionItems(overview(), NOW)).toEqual([]);
    expect(attentionItems(overview({ pending: 4, retrying: 1, oldestPendingAt: minutesAgo(10) }), NOW)).toEqual([]);
  });

  it("says when events gave up, in the singular and the plural", () => {
    const one = attentionItems(overview({ failed: 1 }), NOW);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatch(/^1 message for other servers gave up/);
    expect(attentionItems(overview({ failed: 3 }), NOW)[0]).toMatch(/^3 messages for other servers gave up/);
  });

  it("says when something has been waiting for an hour or more, and not a minute before", () => {
    expect(STUCK_AFTER_MS).toBe(60 * 60 * 1000);
    expect(attentionItems(overview({ pending: 1, oldestPendingAt: minutesAgo(59) }), NOW)).toEqual([]);
    const stuck = attentionItems(overview({ pending: 1, oldestPendingAt: minutesAgo(60) }), NOW);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toContain("1 hour ago");
  });

  it("says both when both are true", () => {
    expect(attentionItems(overview({ pending: 2, failed: 2, oldestPendingAt: minutesAgo(180) }), NOW)).toHaveLength(2);
  });
});
