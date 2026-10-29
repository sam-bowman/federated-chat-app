import { describe, expect, it } from "vitest";
import {
  ERASED_SNAPSHOT,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_TEXT,
  REPORT_REASONS,
  cleanLine,
  cleanText,
  communitySnapshot,
  isReportKind,
  isReportReason,
  isResolveAction,
  messageSnapshot,
  parseReportRetentionDays,
  targetKeyOf,
  userSnapshot,
} from "./reports.js";

const owner = { identity: "@o:x", displayName: "O" };

describe("REPORT_RETENTION_DAYS", () => {
  it("is 180 when unset or blank", () => {
    expect(parseReportRetentionDays(undefined)).toBe(180);
    expect(parseReportRetentionDays("  ")).toBe(180);
  });

  it("takes a whole number of days from 0 (keep for ever) to 3650", () => {
    expect(parseReportRetentionDays("0")).toBe(0);
    expect(parseReportRetentionDays(" 30 ")).toBe(30);
    expect(parseReportRetentionDays("3650")).toBe(3650);
  });

  it("refuses anything that could be a typo, naming the setting", () => {
    for (const bad of ["-1", "3651", "1.5", "180d", "abc", "1e3", "０", "12345"]) {
      expect(() => parseReportRetentionDays(bad), bad).toThrow(/REPORT_RETENTION_DAYS/u);
    }
  });
});

describe("the lists", () => {
  it("know what they accept", () => {
    expect(isReportKind("message")).toBe(true);
    expect(isReportKind("toString")).toBe(false);
    expect(isReportKind(1)).toBe(false);
    expect(REPORT_REASONS.every(isReportReason)).toBe(true);
    expect(isReportReason("rude")).toBe(false);
    expect(isResolveAction("member_banned")).toBe(true);
    expect(isResolveAction("")).toBe(false);
  });

  it("make the key that stops one person reporting a thing twice", () => {
    expect(targetKeyOf("message", "abc")).toBe("message:abc");
    expect(targetKeyOf("user", "abc")).not.toBe(targetKeyOf("message", "abc"));
  });
});

describe("cleaning text", () => {
  it("a line loses control, direction and zero-width characters and runs of space, and is cut", () => {
    expect(cleanLine("  a‮b​c \n\t d  ")).toBe("a b c d");
    expect(cleanLine("‮​ ")).toBeNull();
    expect(cleanLine(null)).toBeNull();
    expect([...cleanLine("x".repeat(500), 10)!]).toHaveLength(10);
    expect(cleanLine("x".repeat(500), 10)!.endsWith("…")).toBe(true);
  });

  it("running text keeps its line breaks and tabs but nothing that could hide or reorder it", () => {
    expect(cleanText("one\ntwo\tthree‮four​\u0007", 100)).toBe("one\ntwo\tthreefour");
    expect(cleanText("   ", 100)).toBeNull();
    expect(cleanText(undefined, 100)).toBeNull();
  });

  it("cuts by characters, not code units, so an emoji is not split", () => {
    const cut = cleanText("😀".repeat(50), 10)!;
    expect([...cut]).toHaveLength(10);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});

describe("snapshots", () => {
  const sender = { identity: "@bob:chat.example", displayName: "Bob" };
  const base = { content: "hello", attachmentUrls: [], createdAt: new Date("2026-10-29T10:00:00Z"), editedAt: null, sender };

  it("a message holds the text, when, who, and where, field by field", () => {
    expect(messageSnapshot({ ...base, where: { community: "Club", channel: "general" } })).toEqual({
      type: "message",
      text: "hello",
      attachments: [],
      attachmentCount: 0,
      sentAt: "2026-10-29T10:00:00.000Z",
      editedAt: null,
      where: { community: "Club", channel: "general" },
      sender,
    });
  });

  it("a message in a conversation names no one but the sender", () => {
    const snapshot = messageSnapshot({ ...base, where: { conversation: "direct" } });
    expect(snapshot.where).toEqual({ conversation: "direct" });
  });

  it("limits the text and the attachment addresses, and says how many there were", () => {
    const urls = Array.from({ length: MAX_ATTACHMENTS + 4 }, (_, i) => `/uploads/${i}.png`);
    const snapshot = messageSnapshot({ ...base, content: "z".repeat(MAX_MESSAGE_TEXT * 2), attachmentUrls: urls, where: { conversation: "group" } });
    expect([...snapshot.text!]).toHaveLength(MAX_MESSAGE_TEXT);
    expect(snapshot.attachments).toEqual(urls.slice(0, MAX_ATTACHMENTS));
    expect(snapshot.attachmentCount).toBe(urls.length);
  });

  it("does not copy a field it was not given (a column added to a table later is not kept until someone decides it should be)", () => {
    const row = { identity: "@bob:x", displayName: "Bob", bio: "b", pronouns: "p", customStatus: "s", passwordHash: "secret", email: "e@x" };
    expect(Object.keys(userSnapshot(row)).sort()).toEqual(["bio", "customStatus", "displayName", "identity", "pronouns", "type"]);
    expect(JSON.stringify(userSnapshot(row))).not.toMatch(/secret|e@x/u);
  });

  it("a community holds its name, description, icon text and owner", () => {
    expect(communitySnapshot({ name: "Club", description: "d", iconText: "C", owner })).toEqual({
      type: "community",
      name: "Club",
      description: "d",
      iconText: "C",
      owner: { identity: "@o:x", displayName: "O" },
    });
  });

  it("is replaced by one marker when the person is erased", () => {
    expect(ERASED_SNAPSHOT).toEqual({ type: "erased" });
  });
});
