import { describe, expect, it } from "vitest";
import { parseWebhooksEnabled, parseWebhooksPerCommunityLimit } from "./webhooksEnabled.js";

describe("WEBHOOKS_ENABLED", () => {
  it("is on unless clearly switched off", () => {
    for (const v of [undefined, "", "  ", "true", "TRUE", "1", "yes", "on"]) expect(parseWebhooksEnabled(v)).toBe(true);
    for (const v of ["false", "False", "0", "no", "off", " off "]) expect(parseWebhooksEnabled(v)).toBe(false);
  });

  it("refuses a value that could be a typo, rather than leaving webhooks on", () => {
    for (const v of ["fasle", "disabled", "2", "maybe"]) expect(() => parseWebhooksEnabled(v)).toThrow(/WEBHOOKS_ENABLED/);
  });
});

describe("WEBHOOKS_PER_COMMUNITY_LIMIT", () => {
  it("defaults to 10 and takes a whole number from 0 to 100", () => {
    expect(parseWebhooksPerCommunityLimit(undefined)).toBe(10);
    expect(parseWebhooksPerCommunityLimit("")).toBe(10);
    expect(parseWebhooksPerCommunityLimit("0")).toBe(0);
    expect(parseWebhooksPerCommunityLimit("100")).toBe(100);
  });

  it("refuses anything else", () => {
    for (const v of ["-1", "101", "2.5", "many", "1e1x"]) expect(() => parseWebhooksPerCommunityLimit(v)).toThrow(/WEBHOOKS_PER_COMMUNITY_LIMIT/);
  });
});
