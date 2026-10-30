import { describe, expect, it } from "vitest";
import type { Report } from "../api";
import { ApiError } from "../api/client";
import serverReports from "../../../server/src/lib/reports.ts?raw";
import {
  MAX_DETAILS,
  MAX_NOTE,
  REPORT_REASON_OPTIONS,
  RESOLVE_ACTION_OPTIONS,
  actionLabel,
  historyLine,
  reasonLabel,
  reportFailureMessage,
  resolutionLine,
} from "./reports";

// The client cannot import the server, so its lists are checked against the server's source text: a reason or action added there has to be
// given words here, or the form would not offer it and the queue would show only its raw name.
const listFromServer = (name: string) => {
  const block = new RegExp(`export const ${name} = \\[([^\\]]+)\\]`).exec(serverReports);
  expect(block, name).not.toBeNull();
  return [...block![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
};
const limitFromServer = (name: string) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(serverReports)![1]);

describe("the lists the server defines", () => {
  it("offers every reason, in the server's words and no others", () => {
    expect(REPORT_REASON_OPTIONS.map((o) => o.value).sort()).toEqual(listFromServer("REPORT_REASONS").sort());
  });

  it("has words for every way a report can be resolved, and no others", () => {
    expect(RESOLVE_ACTION_OPTIONS.map((o) => o.value).sort()).toEqual(listFromServer("RESOLVE_ACTIONS").sort());
  });

  it("limits the reporter's words and a note as the server does", () => {
    expect(MAX_DETAILS).toBe(limitFromServer("MAX_DETAILS_LENGTH"));
    expect(MAX_NOTE).toBe(limitFromServer("MAX_NOTE_LENGTH"));
  });

  it("shows a name it does not know as it came", () => {
    expect(reasonLabel("spam")).toBe("Spam");
    expect(reasonLabel("brand_new")).toBe("brand_new");
    expect(actionLabel("brand_new")).toBe("brand_new");
    expect(actionLabel(null)).toBe("");
  });
});

describe("telling the reporter why it did not work", () => {
  const refused = (error: string, status = 409) => new ApiError(status, { error });

  it("sends the reporter of something on a server that cannot take reports yet to its moderators, naming it", () => {
    const text = reportFailureMessage(refused("remote_community"), "message", "far.example");
    expect(text).toContain("another server (far.example)");
    expect(text).toContain("can't take reports from other servers yet");
    expect(text).toContain("Report it to that server's moderators");
    expect(reportFailureMessage(refused("remote_community"), "community")).not.toContain("()");
  });

  it("says each of the other refusals in its own words", () => {
    expect(reportFailureMessage(refused("already_reported"), "user")).toContain("already reported this person");
    expect(reportFailureMessage(refused("already_reported"), "message")).toContain("this message");
    expect(reportFailureMessage(refused("too_many_reports", 429), "message")).toContain("Wait a while");
    expect(reportFailureMessage(refused("cannot_report_self", 400), "user")).toContain("yourself");
    expect(reportFailureMessage(refused("not_found", 404), "community")).toContain("community isn't available");
  });

  it("says what happened when the report was on its way to another server", () => {
    expect(reportFailureMessage(refused("not_a_member", 403), "message", "far.example")).toContain("not a member of that community any more");
    expect(reportFailureMessage(refused("federation_unreachable", 502), "message", "far.example")).toContain("Couldn't reach far.example");
    expect(reportFailureMessage(refused("federation_unreachable", 502), "message")).toContain("Couldn't reach that server");
    expect(reportFailureMessage(refused("federation_disabled", 403), "message", "far.example")).toMatch(/doesn't connect to other servers/);
    expect(reportFailureMessage(refused("federation_domain_blocked", 403), "message", "far.example")).toMatch(/server/);
  });

  it("does not blame the person for a failure it cannot explain, and tells a lost connection apart", () => {
    expect(reportFailureMessage(refused("something_else", 500), "message")).toContain("Try again");
    expect(reportFailureMessage(new TypeError("Failed to fetch"), "message")).toContain("connection");
  });
});

describe("a report in words", () => {
  const report = (over: Partial<Report> = {}): Report => ({
    id: "r1",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "message",
    scope: "community",
    status: "open",
    reason: "spam",
    details: null,
    reporter: { id: "u1", label: "@kim:chat.example", history: { total: 3, dismissed: 1 } },
    target: { id: "m1", userId: "u2", label: "@bob:chat.example" },
    communityId: "c1",
    snapshot: { type: "message", text: "hi" },
    resolution: null,
    ...over,
  });

  it("says how the reporter's past reports went, where they were made", () => {
    expect(historyLine({ total: 3, dismissed: 1 }, true)).toBe("3 reports in this community, 1 dismissed");
    expect(historyLine({ total: 1, dismissed: 0 }, false)).toBe("1 report on this server");
    expect(historyLine(null, true)).toBeNull();
  });

  it("says nothing of an open report's resolution, and who closed a closed one and how", () => {
    expect(resolutionLine(report())).toBeNull();
    expect(resolutionLine(report({ status: "dismissed", resolution: { at: null, by: "@mod:chat.example", action: null, note: null } }))).toBe("Dismissed by @mod:chat.example");
    expect(resolutionLine(report({ status: "resolved", resolution: { at: null, by: "@mod:chat.example", action: "member_banned", note: null } }))).toBe(
      "Resolved (member banned) by @mod:chat.example"
    );
    expect(resolutionLine(report({ status: "resolved", resolution: { at: null, by: null, action: null, note: null } }))).toBe("Resolved");
  });
});
