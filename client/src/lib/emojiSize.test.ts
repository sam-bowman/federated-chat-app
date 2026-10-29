import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMOJI_SIZE_KEY, applyEmojiSize, getEmojiSize, parseEmojiSize, setEmojiSize, startEmojiSize } from "./emojiSize";

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.emojiSize;
  startEmojiSize();
});
afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.emojiSize;
});

describe("reading the stored choice", () => {
  it("is large unless it says normal, whatever else is stored", () => {
    expect(parseEmojiSize(null)).toBe("large");
    expect(parseEmojiSize("normal")).toBe("normal");
    expect(parseEmojiSize("large")).toBe("large");
    expect(parseEmojiSize("huge")).toBe("large");
    expect(parseEmojiSize({})).toBe("large");
  });

  it("starts from what is stored", () => {
    window.localStorage.setItem(EMOJI_SIZE_KEY, "normal");
    startEmojiSize();
    expect(getEmojiSize()).toBe("normal");
    expect(document.documentElement.dataset.emojiSize).toBe("normal");
  });
});

describe("changing it", () => {
  it("marks the page only for normal, and remembers it", () => {
    setEmojiSize("normal");
    expect(document.documentElement.dataset.emojiSize).toBe("normal");
    expect(window.localStorage.getItem(EMOJI_SIZE_KEY)).toBe("normal");
    expect(getEmojiSize()).toBe("normal");
  });

  it("leaves no mark and no stored value for the default, so a later change of the default reaches everyone who never chose", () => {
    setEmojiSize("normal");
    setEmojiSize("large");
    expect("emojiSize" in document.documentElement.dataset).toBe(false);
    expect(window.localStorage.getItem(EMOJI_SIZE_KEY)).toBeNull();
  });

  it("follows a change made in another tab", () => {
    window.localStorage.setItem(EMOJI_SIZE_KEY, "normal");
    window.dispatchEvent(new StorageEvent("storage", { key: EMOJI_SIZE_KEY, newValue: "normal" }));
    expect(getEmojiSize()).toBe("normal");
    expect(document.documentElement.dataset.emojiSize).toBe("normal");
  });

  it("ignores another tab's change to something else", () => {
    setEmojiSize("normal");
    window.dispatchEvent(new StorageEvent("storage", { key: "chat.other", newValue: "x" }));
    expect(getEmojiSize()).toBe("normal");
  });

  it("applies without storing when asked to apply only", () => {
    applyEmojiSize("normal");
    expect(document.documentElement.dataset.emojiSize).toBe("normal");
    expect(window.localStorage.getItem(EMOJI_SIZE_KEY)).toBeNull();
  });
});
