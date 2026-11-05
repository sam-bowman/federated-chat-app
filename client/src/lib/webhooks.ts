import { ApiError } from "../api/client";

// Incoming webhooks (#132, phase 2) as the client words them. The server's rules are in modules/webhooks/routes.ts; this only turns its codes
// into sentences and holds the one limit a name must obey, which the server checks again.

/** The longest name a webhook may have (the server refuses more). */
export const WEBHOOK_NAME_MAX = 64;

export function isValidWebhookName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && name.length <= WEBHOOK_NAME_MAX;
}

/** What to say when something about a webhook did not work. `error` is whatever was thrown. */
export function webhookFailureMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Couldn't reach the server. Try again.";
  const code = typeof error.body === "object" && error.body && "error" in error.body ? String((error.body as { error: unknown }).error) : "";
  switch (code) {
    case "forbidden":
      return "You need the Manage webhooks permission for that.";
    case "webhooks_disabled":
      return "This server has switched webhooks off.";
    case "too_many_webhooks":
      return "This community already has as many webhooks as the server allows. Delete one first.";
    case "channel_not_found":
      return "That channel isn't a text channel of this community any more.";
    case "not_community_home":
      return "Webhooks can only be made for a community hosted on this server.";
    case "invalid_request":
      return `Give it a name of 1 to ${WEBHOOK_NAME_MAX} characters and choose a channel.`;
    case "not_found":
      return "That webhook no longer exists.";
    default:
      return "Something went wrong. Try again.";
  }
}
