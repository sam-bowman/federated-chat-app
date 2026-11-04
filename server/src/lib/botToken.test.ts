import { describe, expect, it } from "vitest";
import { BOT_TOKEN_PREFIX, botTokenFromHeader, generateBotToken, hashBotToken, looksLikeBotToken } from "./botToken.js";

describe("bot tokens (#132)", () => {
  it("makes a long random token with the prefix, a new one every time", () => {
    const a = generateBotToken();
    const b = generateBotToken();
    expect(a.startsWith(BOT_TOKEN_PREFIX)).toBe(true);
    expect(looksLikeBotToken(a)).toBe(true);
    expect(a).not.toBe(b);
    // 32 random bytes in base64url.
    expect(a.length).toBe(BOT_TOKEN_PREFIX.length + 43);
  });

  it("only accepts the exact shape", () => {
    expect(looksLikeBotToken("")).toBe(false);
    expect(looksLikeBotToken("mcb_short")).toBe(false);
    expect(looksLikeBotToken("xyz_" + "A".repeat(43))).toBe(false);
    expect(looksLikeBotToken("mcb_" + "A".repeat(44))).toBe(false);
    expect(looksLikeBotToken("mcb_" + "A".repeat(42) + "!")).toBe(false);
    expect(looksLikeBotToken("mcb_" + "A".repeat(43) + "\n")).toBe(false);
    expect(looksLikeBotToken("mcb_" + "A".repeat(43))).toBe(true);
  });

  it("hashes to a stable value that is not the token", () => {
    const token = generateBotToken();
    expect(hashBotToken(token)).toBe(hashBotToken(token));
    expect(hashBotToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBotToken(token)).not.toContain(token);
    expect(hashBotToken(token)).not.toBe(hashBotToken(generateBotToken()));
  });

  it("reads the token only from the Bot scheme", () => {
    expect(botTokenFromHeader("Bot abc")).toBe("abc");
    expect(botTokenFromHeader("Bot   abc  ")).toBe("abc");
    expect(botTokenFromHeader("Bearer abc")).toBeNull();
    expect(botTokenFromHeader("bot abc")).toBeNull();
    expect(botTokenFromHeader(undefined)).toBeNull();
    expect(botTokenFromHeader("")).toBeNull();
  });
});
