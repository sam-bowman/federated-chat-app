import { beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../api";
import { CACHED_PER_CHAT, MAX_CACHED_CHATS, cachedHistory, clearHistoryCache, rememberHistory } from "./messageCache";

const message = (n: number): Message => ({ id: `m${n}`, content: `message ${n}` }) as Message;
const messages = (count: number, from = 1) => Array.from({ length: count }, (_, i) => message(from + i));

beforeEach(clearHistoryCache);

describe("the kept history of a chat", () => {
  it("is nothing until a chat has been looked at, and is what was kept after", () => {
    expect(cachedHistory("me", "chat")).toBeUndefined();
    rememberHistory("me", "chat", messages(3), false);
    expect(cachedHistory("me", "chat")).toEqual({ messages: messages(3), hasMore: false });
    expect(cachedHistory("me", "other")).toBeUndefined();
  });

  it("keeps only the newest page, and says there is more when it left some out", () => {
    rememberHistory("me", "long", messages(CACHED_PER_CHAT + 5), false);
    const kept = cachedHistory("me", "long")!;
    expect(kept.messages).toHaveLength(CACHED_PER_CHAT);
    expect(kept.messages[0].id).toBe("m6");
    expect(kept.messages.at(-1)?.id).toBe(`m${CACHED_PER_CHAT + 5}`);
    expect(kept.hasMore).toBe(true);
  });

  it("keeps what the server said about there being more, when nothing was left out", () => {
    rememberHistory("me", "a", messages(CACHED_PER_CHAT), true);
    expect(cachedHistory("me", "a")?.hasMore).toBe(true);
    rememberHistory("me", "b", messages(2), false);
    expect(cachedHistory("me", "b")?.hasMore).toBe(false);
  });

  it("replaces what was kept for a chat, so it is the latest that is shown", () => {
    rememberHistory("me", "chat", messages(2), false);
    rememberHistory("me", "chat", messages(4), false);
    expect(cachedHistory("me", "chat")?.messages).toHaveLength(4);
  });

  it("is never one person's chats for another: a different account starts empty, and the first one's are gone for good", () => {
    rememberHistory("alice", "chat", messages(2), false);
    expect(cachedHistory("bob", "chat")).toBeUndefined();
    expect(cachedHistory("alice", "chat")).toBeUndefined();
  });

  it("keeps nothing for no one (signed out)", () => {
    rememberHistory(undefined, "chat", messages(2), false);
    expect(cachedHistory(undefined, "chat")).toBeUndefined();
    rememberHistory("me", "chat", messages(2), false);
    expect(cachedHistory(undefined, "chat")).toBeUndefined(); // looking as no one empties it
    expect(cachedHistory("me", "chat")).toBeUndefined();
  });

  it("lets go of the chat longest unused when there are too many", () => {
    for (let i = 0; i < MAX_CACHED_CHATS; i++) rememberHistory("me", `chat${i}`, messages(1), false);
    cachedHistory("me", "chat0"); // looked at again: no longer the oldest
    rememberHistory("me", "one-too-many", messages(1), false);
    expect(cachedHistory("me", "chat0")).toBeDefined();
    expect(cachedHistory("me", "chat1")).toBeUndefined();
    expect(cachedHistory("me", "chat2")).toBeDefined();
    expect(cachedHistory("me", "one-too-many")).toBeDefined();
  });

  it("counts remembering a chat again as using it, so a chat that is kept up to date is not the one let go of", () => {
    for (let i = 0; i < MAX_CACHED_CHATS; i++) rememberHistory("me", `chat${i}`, messages(1), false);
    rememberHistory("me", "chat0", messages(2), false); // the oldest, brought up to date
    rememberHistory("me", "one-too-many", messages(1), false);
    expect(cachedHistory("me", "chat0")?.messages).toHaveLength(2);
    expect(cachedHistory("me", "chat1")).toBeUndefined();
  });

  it("is emptied on demand", () => {
    rememberHistory("me", "chat", messages(2), false);
    clearHistoryCache();
    expect(cachedHistory("me", "chat")).toBeUndefined();
  });
});
