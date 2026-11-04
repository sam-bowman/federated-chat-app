import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { botFailureMessage, isValidBotUsername } from "./bots";

describe("bot names", () => {
  it("takes what the server takes: 3 to 32 lowercase letters, digits and underscores", () => {
    for (const ok of ["abc", "my_bot", "bot_2", "a".repeat(32)]) expect(isValidBotUsername(ok), ok).toBe(true);
    for (const bad of ["", "ab", "a".repeat(33), "My_Bot", "my bot", "bot-1", "bot\n", "böt"]) expect(isValidBotUsername(bad), bad).toBe(false);
  });
});

describe("what to say when a bot action fails", () => {
  const said = (code: string) => botFailureMessage(new ApiError(409, { error: code }));
  it("has words for every code the server gives", () => {
    for (const code of ["username_taken", "too_many_bots", "bots_disabled", "invalid_request", "bot_not_found", "already_member", "bot_banned", "forbidden", "not_community_home"]) {
      expect(said(code), code).not.toMatch(/something went wrong/i);
    }
  });

  it("never shows a raw code, and treats anything that is not the server answering as a connection problem", () => {
    expect(said("something_new")).toMatch(/something went wrong/i);
    expect(said("something_new")).not.toContain("something_new");
    expect(botFailureMessage(new TypeError("fetch failed"))).toMatch(/reach the server/i);
  });
});
