import { ApiError } from "../api/client";

// Bot accounts (#132) as the client words them. The server's rules are in modules/bots/routes.ts; this only turns its codes into sentences and
// holds the one pattern a username must match, which the server checks again.

/** What the server accepts for a bot's name: the same as anyone's. */
export const BOT_USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

export function isValidBotUsername(value: string): boolean {
  return BOT_USERNAME_PATTERN.test(value);
}

/** What to say when something about a bot did not work. `error` is whatever was thrown. */
export function botFailureMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Couldn't reach the server. Try again.";
  const code = typeof error.body === "object" && error.body && "error" in error.body ? String((error.body as { error: unknown }).error) : "";
  switch (code) {
    case "username_taken":
      return "That name is already taken. Choose another.";
    case "too_many_bots":
      return "You already have as many bots as this server allows. Delete one first.";
    case "bots_disabled":
      return "This server does not have bots.";
    case "invalid_request":
      return "Use 3 to 32 lowercase letters, digits or underscores for the name.";
    case "bot_not_found":
      return "There is no bot with that name on this server.";
    case "already_member":
      return "That bot is already in this community.";
    case "bot_banned":
      return "That bot is banned from this community. Unban it first.";
    case "forbidden":
      return "You need the Manage community permission to add a bot.";
    case "not_community_home":
      return "Bots can only be added to a community hosted on this server.";
    default:
      return "Something went wrong. Try again.";
  }
}
