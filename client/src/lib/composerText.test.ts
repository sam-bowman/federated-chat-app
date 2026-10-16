import { describe, expect, it } from "vitest";
import type { Emoticon } from "../api";
import { completeTrigger, insertAtCursor, MAX_SUGGESTIONS, suggestEmoticons, triggerBeingTyped } from "./composerText";

describe("insertAtCursor", () => {
  it("inserts in the middle, not at the end, with the caret after it", () => {
    const edit = insertAtCursor("hello world", 5, 5, ":smile:", true);
    expect(edit.value).toBe("hello :smile: world");
    expect(edit.caret).toBe("hello :smile: ".length);
  });

  it("replaces a selection, whichever way round it was made", () => {
    expect(insertAtCursor("say WORD now", 4, 8, ":x:", true).value).toBe("say :x: now");
    expect(insertAtCursor("say WORD now", 8, 4, ":x:", true).value).toBe("say :x: now");
  });

  it("adds a space before only when the text before is not already whitespace, and one after unless one follows", () => {
    expect(insertAtCursor("", 0, 0, ":a:", true)).toEqual({ value: ":a: ", caret: 4 });
    expect(insertAtCursor("hi ", 3, 3, ":a:", true).value).toBe("hi :a: ");
    expect(insertAtCursor("hi", 2, 2, ":a:", true).value).toBe("hi :a: ");
    expect(insertAtCursor("hi there", 3, 3, ":a:", true).value).toBe("hi :a: there");
  });

  it("puts a Unicode emoji in exactly as it is, with no spaces", () => {
    expect(insertAtCursor("hi", 2, 2, "😀", false)).toEqual({ value: "hi😀", caret: 4 });
    expect(insertAtCursor("ab", 1, 1, "😀", false).value).toBe("a😀b");
  });

  it("copes with a caret outside the text", () => {
    expect(insertAtCursor("ab", 50, 50, "😀", false).value).toBe("ab😀");
  });
});

describe("triggerBeingTyped", () => {
  it("needs a colon plus two characters, before the caret", () => {
    expect(triggerBeingTyped(":p", 2)).toBeNull();
    expect(triggerBeingTyped(":pa", 3)).toEqual({ start: 0, end: 3, query: "pa" });
    expect(triggerBeingTyped("so :Part", 8)).toEqual({ start: 3, end: 8, query: "part" });
  });

  it("looks only at the word the caret is in", () => {
    expect(triggerBeingTyped(":party rest", 6)).toEqual({ start: 0, end: 6, query: "party" });
    expect(triggerBeingTyped(":party rest", 11)).toBeNull();
  });

  it("ignores a colon inside a word, a finished trigger, and anything that is not a trigger character", () => {
    expect(triggerBeingTyped("10:30", 5)).toBeNull();
    expect(triggerBeingTyped("https://x", 9)).toBeNull();
    expect(triggerBeingTyped(":party:", 7)).toBeNull();
    expect(triggerBeingTyped(":pa-r", 5)).toBeNull();
  });
});

describe("completeTrigger", () => {
  it("replaces the half-typed word with the whole trigger and a space", () => {
    const value = "look :par";
    const match = triggerBeingTyped(value, value.length)!;
    expect(completeTrigger(value, match, ":party:")).toEqual({ value: "look :party: ", caret: 13 });
  });

  it("works in the middle of a message", () => {
    const value = "look :par later";
    const match = triggerBeingTyped(value, 9)!;
    expect(completeTrigger(value, match, ":party:").value).toBe("look :party: later");
  });
});

describe("suggestEmoticons", () => {
  it("caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `n${i}`, trigger: `:party${i}:` }) as Emoticon);
    expect(suggestEmoticons(many, "party")).toHaveLength(MAX_SUGGESTIONS);
  });
});
