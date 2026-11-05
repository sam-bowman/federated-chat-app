import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { WEBHOOK_NAME_MAX, isValidWebhookName, webhookFailureMessage } from "./webhooks";

describe("a webhook's name", () => {
  it("is 1 to 64 characters once trimmed", () => {
    expect(isValidWebhookName("Deploys")).toBe(true);
    expect(isValidWebhookName("  Deploys  ")).toBe(true);
    expect(isValidWebhookName("x".repeat(WEBHOOK_NAME_MAX))).toBe(true);
    expect(isValidWebhookName("x".repeat(WEBHOOK_NAME_MAX + 1))).toBe(false);
    expect(isValidWebhookName("")).toBe(false);
    expect(isValidWebhookName("   ")).toBe(false);
  });
});

describe("webhookFailureMessage", () => {
  const say = (code: unknown) => webhookFailureMessage(new ApiError(400, code === undefined ? undefined : { error: code }));

  it("turns each of the server's codes into a sentence of its own", () => {
    const sentences = ["forbidden", "webhooks_disabled", "too_many_webhooks", "channel_not_found", "not_community_home", "invalid_request", "not_found"].map(say);
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const s of sentences) expect(s).not.toMatch(/Something went wrong|Couldn't reach/);
  });

  it("does not guess at a code it does not know, or at an answer with none", () => {
    expect(say("something_new")).toBe("Something went wrong. Try again.");
    expect(say(undefined)).toBe("Something went wrong. Try again.");
    expect(say(42)).toBe("Something went wrong. Try again.");
  });

  it("says it could not reach the server for anything that is not an answer from it", () => {
    expect(webhookFailureMessage(new TypeError("network"))).toBe("Couldn't reach the server. Try again.");
    expect(webhookFailureMessage(undefined)).toBe("Couldn't reach the server. Try again.");
  });
});
