import { describe, expect, it } from "vitest";
import type { Reaction } from "../api";
import { choiceOf, hasReacted, reactionKey } from "./reactions";

const party = { id: "E1", name: "Party", imageUrl: "https://cdn.example/party.png" };
const emoji: Reaction = { emoji: "👍", count: 1, users: ["bob"] };
const custom: Reaction = { emoticon: party, count: 2, users: ["bob", "alice"] };

describe("reaction helpers", () => {
  it("keeps an emoticon apart from an emoji, and two emoticons from each other, and renames do not matter", () => {
    expect(new Set([reactionKey(emoji), reactionKey(custom), reactionKey({ ...custom, emoticon: { ...party, id: "E2" } })]).size).toBe(3);
    expect(reactionKey({ emoticon: { ...party, name: "Renamed" } })).toBe(reactionKey(custom));
  });

  it("turns a pill back into what to send", () => {
    expect(choiceOf(emoji)).toEqual({ emoji: "👍" });
    expect(choiceOf(custom)).toEqual({ emoticon: party });
  });

  it("knows whether this person already reacted with it", () => {
    const message = { reactions: [emoji, custom] };
    expect(hasReacted(message, { emoji: "👍" }, "bob")).toBe(true);
    expect(hasReacted(message, { emoji: "👍" }, "alice")).toBe(false);
    expect(hasReacted(message, { emoticon: party }, "alice")).toBe(true);
    expect(hasReacted(message, { emoticon: { ...party, id: "E9" } }, "alice")).toBe(false);
    expect(hasReacted(message, { emoji: "😀" }, "bob")).toBe(false);
  });
});
