import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../api";
import { clearHistoryCache } from "./messageCache";
import { useMessageHistory } from "./useMessageHistory";

vi.mock("../api", () => ({ MESSAGE_PAGE_SIZE: 3 }));

const message = (id: string, content = id): Message => ({ id, content }) as Message;

/** A `load` whose answers the test gives, one chat at a time. */
function loader() {
  const waiting = new Map<string, ((page: Message[]) => void)[]>();
  const failing = new Map<string, ((error: Error) => void)[]>();
  const load = vi.fn((id: string) => new Promise<Message[]>((resolve, reject) => {
    waiting.set(id, [...(waiting.get(id) ?? []), resolve]);
    failing.set(id, [...(failing.get(id) ?? []), reject]);
  }));
  return {
    load,
    answer: async (id: string, page: Message[]) => {
      const resolve = waiting.get(id)?.shift();
      failing.get(id)?.shift();
      await act(async () => resolve?.(page));
    },
    fail: async (id: string) => {
      waiting.get(id)?.shift();
      const reject = failing.get(id)?.shift();
      await act(async () => reject?.(new Error("down")));
    },
  };
}

const ids = (messages: Message[]) => messages.map((m) => m.id);
/** `first` null is no chat at all (not "the default one"). */
const open = (userId: string | undefined, load: (id: string) => Promise<Message[]>, first: string | null = "A") =>
  renderHook(({ id }: { id: string | undefined }) => useMessageHistory(userId, id, load), { initialProps: { id: first ?? undefined } });

beforeEach(clearHistoryCache);

describe("useMessageHistory", () => {
  it("has nothing, and says it is not known yet, until the messages arrive; then has them", async () => {
    const { load, answer } = loader();
    const { result } = open("me", load);
    expect(result.current.messages).toEqual([]);
    expect(result.current.loaded).toBe(false);
    await answer("A", [message("a1"), message("a2")]);
    expect(ids(result.current.messages)).toEqual(["a1", "a2"]);
    expect(result.current.loaded).toBe(true);
    expect(load).toHaveBeenCalledWith("A");
  });

  it("says there is more only for a full page", async () => {
    const { load, answer } = loader();
    const { result } = open("me", load);
    await answer("A", [message("a1"), message("a2"), message("a3")]); // the page size here is 3
    expect(result.current.hasMore).toBe(true);
    const second = open("me", load, "B");
    await answer("B", [message("b1")]);
    expect(second.result.current.hasMore).toBe(false);
  });

  it("never shows another chat's messages: on the render that changes the chat they are already gone", async () => {
    const { load, answer } = loader();
    const { result, rerender } = open("me", load);
    await answer("A", [message("a1")]);
    const seen: string[][] = [];
    rerender({ id: "B" });
    seen.push(ids(result.current.messages));
    expect(seen).toEqual([[]]);
    expect(result.current.loaded).toBe(false);
    await answer("B", [message("b1")]);
    expect(ids(result.current.messages)).toEqual(["b1"]);
  });

  it("shows a chat looked at before at once, then the current messages when they arrive", async () => {
    const { load, answer } = loader();
    const { result, rerender } = open("me", load);
    await answer("A", [message("a1", "old words")]);
    rerender({ id: "B" });
    await answer("B", [message("b1")]);
    rerender({ id: "A" });
    // Straight away, before the server has answered:
    expect(ids(result.current.messages)).toEqual(["a1"]);
    expect(result.current.messages[0].content).toBe("old words");
    expect(result.current.loaded).toBe(true);
    // and then what it says now (the message was edited, and another sent):
    await answer("A", [message("a1", "new words"), message("a2")]);
    expect(result.current.messages.map((m) => m.content)).toEqual(["new words", "a2"]);
  });

  it("remembers that a chat has older messages, and offers them at once when it is opened again", async () => {
    const { load, answer } = loader();
    const { result, rerender } = open("me", load);
    await answer("A", [message("a1"), message("a2"), message("a3")]); // a full page (3 here): there are more
    expect(result.current.hasMore).toBe(true);
    rerender({ id: "B" });
    await answer("B", [message("b1")]);
    expect(result.current.hasMore).toBe(false);
    rerender({ id: "A" });
    expect(result.current.hasMore).toBe(true); // before the server has answered
  });

  it("does not take a chat that was left before it loaded for one that is known to be empty", async () => {
    const { load, answer } = loader();
    const { result, rerender } = open("me", load);
    rerender({ id: "B" }); // A never answered
    rerender({ id: "A" });
    expect(result.current.loaded).toBe(false); // still on its way: "No messages yet" would be a guess
    expect(result.current.messages).toEqual([]);
    await answer("A", [message("from-the-abandoned-ask")]); // the first ask was given up when B was opened
    expect(result.current.loaded).toBe(false);
    await answer("A", [message("a1")]);
    expect(ids(result.current.messages)).toEqual(["a1"]);
    expect(result.current.loaded).toBe(true);
  });

  it("does not lose what arrives live in a chat because the answer for the one before it comes late", async () => {
    const { load, answer } = loader();
    const { result, rerender } = open("me", load);
    rerender({ id: "B" });
    act(() => {
      result.current.setMessages((prev) => [...prev, message("live-in-b")]);
      result.current.noteArrival(message("live-in-b"));
    });
    await answer("A", [message("a-late")]); // A's answer arrives while B is still loading
    await answer("B", [message("b1")]);
    expect(ids(result.current.messages)).toEqual(["b1", "live-in-b"]);
  });

  it("takes a message that was deleted while away out when the current messages arrive", async () => {
    const { load, answer } = loader();
    const { result, rerender } = open("me", load);
    await answer("A", [message("a1"), message("a2")]);
    rerender({ id: "B" });
    await answer("B", []);
    rerender({ id: "A" });
    expect(ids(result.current.messages)).toEqual(["a1", "a2"]);
    await answer("A", [message("a1")]);
    expect(ids(result.current.messages)).toEqual(["a1"]);
  });

  it("is not told 'loaded' for an empty chat before the server has said so", async () => {
    const { load, answer } = loader();
    const { result } = open("me", load);
    expect(result.current.loaded).toBe(false);
    await answer("A", []);
    expect(result.current.loaded).toBe(true);
    expect(result.current.messages).toEqual([]);
  });

  it("keeps a message that arrived live while the history was on its way", async () => {
    const { load, answer } = loader();
    const { result } = open("me", load);
    act(() => {
      result.current.setMessages((prev) => [...prev, message("live")]);
      result.current.noteArrival(message("live"));
    });
    await answer("A", [message("a1")]);
    expect(ids(result.current.messages)).toEqual(["a1", "live"]);
  });

  it("does not bring back a live message that was edited, deleted or whose sender was erased while the history was on its way", async () => {
    const { load, answer } = loader();
    const { result } = open("me", load);
    act(() => {
      for (const m of [message("edited", "first words"), message("removed"), message("stays")]) {
        result.current.setMessages((prev) => [...prev, m]);
        result.current.noteArrival(m);
      }
    });
    act(() => {
      result.current.setMessages((prev) => prev.map((m) => (m.id === "edited" ? message("edited", "second words") : m)));
      result.current.setMessages((prev) => prev.filter((m) => m.id !== "removed")); // as `user:deleted` does for an erased person
    });
    await answer("A", [message("a1")]);
    expect(result.current.messages.map((m) => `${m.id}:${m.content}`)).toEqual(["a1:a1", "edited:second words", "stays:stays"]);
  });

  it("takes the server's copy of a live message that the history already holds", async () => {
    const { load, answer } = loader();
    const { result } = open("me", load);
    act(() => {
      result.current.setMessages((prev) => [...prev, message("m1", "as it arrived")]);
      result.current.noteArrival(message("m1", "as it arrived"));
    });
    await answer("A", [message("m1", "as the server has it")]);
    expect(result.current.messages.map((m) => m.content)).toEqual(["as the server has it"]);
  });

  it("does not keep an arrival from before as part of the next load", async () => {
    const { load, answer } = loader();
    const { result, rerender } = open("me", load);
    act(() => result.current.noteArrival(message("early")));
    rerender({ id: "B" });
    await answer("B", [message("b1")]);
    expect(ids(result.current.messages)).toEqual(["b1"]);
  });

  it("ignores the answer for a chat the person has already left", async () => {
    const { load, answer } = loader();
    const { result, rerender } = open("me", load);
    rerender({ id: "B" });
    await answer("A", [message("a-late")]); // A's answer arrives after moving to B
    expect(result.current.messages).toEqual([]);
    expect(result.current.loaded).toBe(false);
    await answer("B", [message("b1")]);
    expect(ids(result.current.messages)).toEqual(["b1"]);
  });

  it("ignores a change made for a chat that finishes after the person is in another one", async () => {
    const { load, answer } = loader();
    const { result, rerender } = open("me", load);
    await answer("A", [message("a1")]);
    const setForA = result.current.setMessages;
    const setMoreForA = result.current.setHasMore;
    rerender({ id: "B" });
    await answer("B", [message("b1")]);
    act(() => {
      setForA((prev) => [...prev, message("a-sent-late")]);
      setMoreForA(true);
    });
    expect(ids(result.current.messages)).toEqual(["b1"]);
    expect(result.current.hasMore).toBe(false);
    act(() => result.current.setMessages((prev) => [...prev, message("b2")]));
    expect(ids(result.current.messages)).toEqual(["b1", "b2"]);
  });

  it("stops saying the messages are on their way when they could not be loaded, and keeps what it had", async () => {
    const { load, answer, fail } = loader();
    const { result, rerender } = open("me", load);
    await answer("A", [message("a1")]);
    rerender({ id: "B" });
    await fail("B");
    expect(result.current.loaded).toBe(true);
    expect(result.current.messages).toEqual([]);
    rerender({ id: "A" });
    await fail("A");
    expect(ids(result.current.messages)).toEqual(["a1"]);
    expect(result.current.loaded).toBe(true);
  });

  it("is not told a chat is empty because the request for the one before it failed", async () => {
    const { load, answer, fail } = loader();
    const { result, rerender } = open("me", load);
    rerender({ id: "B" });
    await fail("A"); // A's request fails after B was opened
    expect(result.current.loaded).toBe(false);
    expect(result.current.messages).toEqual([]);
    await answer("B", [message("b1")]);
    expect(ids(result.current.messages)).toEqual(["b1"]);
  });

  it("does not lose what arrives live in a chat because the request for the one before it failed late", async () => {
    const { load, answer, fail } = loader();
    const { result, rerender } = open("me", load);
    rerender({ id: "B" });
    act(() => {
      result.current.setMessages((prev) => [...prev, message("live-in-b")]);
      result.current.noteArrival(message("live-in-b"));
    });
    await fail("A");
    await answer("B", [message("b1")]);
    expect(ids(result.current.messages)).toEqual(["b1", "live-in-b"]);
  });

  it("shows no one's chats to a different person", async () => {
    const { load, answer } = loader();
    const first = open("alice", load);
    await answer("A", [message("secret")]);
    first.unmount();
    const second = open("bob", load);
    expect(second.result.current.messages).toEqual([]);
    expect(second.result.current.loaded).toBe(false);
  });

  it("has nothing to load for no chat", async () => {
    const { load } = loader();
    const { result } = open("me", load, null);
    expect(result.current.messages).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("asks for each chat once, not again for a change that is not of chat", async () => {
    const { load, answer } = loader();
    const { result, rerender } = open("me", load);
    await answer("A", [message("a1")]);
    rerender({ id: "A" });
    act(() => result.current.setMessages((prev) => [...prev, message("a2")]));
    await waitFor(() => expect(ids(result.current.messages)).toEqual(["a1", "a2"]));
    expect(load).toHaveBeenCalledTimes(1);
  });
});
