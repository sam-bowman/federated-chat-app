import { describe, expect, it } from "vitest";
import {
  emoticonFallbackText,
  emoticonRefSchema,
  reactionFromWire,
  reactionKey,
  reactionWire,
  type EmoticonRef,
} from "./emoticonReaction.js";

const ref: EmoticonRef = { id: "01HZ0000000000000000000000", name: "Party", imageUrl: "https://a.example/uploads/party.png" };

describe("emoticonRefSchema", () => {
  it("accepts an absolute http(s) picture", () => {
    expect(emoticonRefSchema.safeParse(ref).success).toBe(true);
    expect(emoticonRefSchema.safeParse({ ...ref, imageUrl: "http://a.example/p.png" }).success).toBe(true);
  });

  it("refuses anything a browser could run or that cannot be fetched from another server", () => {
    for (const imageUrl of ["javascript:alert(1)", "data:image/png;base64,AAAA", "/uploads/party.png", "ftp://a.example/p.png", "not a url", "httpx://a.example/p.png"]) {
      expect(emoticonRefSchema.safeParse({ ...ref, imageUrl }).success, imageUrl).toBe(false);
    }
  });

  it("caps the lengths and needs every field", () => {
    expect(emoticonRefSchema.safeParse({ ...ref, name: "n".repeat(41) }).success).toBe(false);
    expect(emoticonRefSchema.safeParse({ ...ref, id: "i".repeat(65) }).success).toBe(false);
    expect(emoticonRefSchema.safeParse({ ...ref, imageUrl: `https://a.example/${"x".repeat(2100)}` }).success).toBe(false);
    expect(emoticonRefSchema.safeParse({ ...ref, name: "" }).success).toBe(false);
    expect(emoticonRefSchema.safeParse({ id: ref.id, name: ref.name }).success).toBe(false);
  });
});

describe("the wire form", () => {
  it("sends a Unicode emoji as it is", () => {
    expect(reactionWire({ emoji: "👍" })).toEqual({ emoji: "👍" });
  });

  it("sends an emoticon with a text fallback an older server accepts (at most 32 characters)", () => {
    expect(reactionWire({ emoticon: ref })).toEqual({ emoji: ":Party:", emoticon: ref });
    expect(emoticonFallbackText("x".repeat(40))).toHaveLength(32);
  });

  it("reads the emoticon in preference to its fallback, and the emoji when there is no emoticon", () => {
    expect(reactionFromWire({ emoji: ":Party:", emoticon: ref })).toEqual({ emoticon: ref });
    expect(reactionFromWire({ emoji: "👍" })).toEqual({ emoji: "👍" });
    expect(reactionFromWire({})).toBeNull();
  });
});

describe("reactionKey", () => {
  it("tells two emoticons, and an emoticon from an emoji that looks the same, apart", () => {
    const keys = [reactionKey({ emoji: "👍" }), reactionKey({ emoticon: ref }), reactionKey({ emoticon: { ...ref, id: "other" } })];
    expect(new Set(keys).size).toBe(3);
  });

  it("is the same for the same reaction", () => {
    expect(reactionKey({ emoticon: { ...ref, name: "Renamed" } })).toBe(reactionKey({ emoticon: ref }));
    expect(reactionKey({ emoji: "👍" })).toBe(reactionKey({ emoji: "👍" }));
  });
});
