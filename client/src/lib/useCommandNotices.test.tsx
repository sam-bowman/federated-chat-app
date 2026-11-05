import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIDNT_RESPOND_MS, THINKING_MS } from "./commandNotices";
import { useCommandNotices } from "./useCommandNotices";

const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    handlers,
    subscribe: (type: string, fn: (payload: unknown) => void) => {
      const set = handlers.get(type) ?? new Set();
      set.add(fn);
      handlers.set(type, set);
      return () => set.delete(fn);
    },
    emit: (type: string, payload: unknown) => handlers.get(type)?.forEach((fn) => fn(payload)),
  };
});
vi.mock("../context/WsContext", () => ({ useWs: () => ({ subscribe: ws.subscribe }) }));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  ws.handlers.clear();
});

const base = (id: string, channelId = "ch1") => ({ interactionId: id, channelId, botName: "Robo", commandName: "request" });
const kinds = (r: { current: ReturnType<typeof useCommandNotices> }) => r.current.notices.map((n) => `${n.interactionId}:${n.kind}`);

describe("useCommandNotices", () => {
  it("shows a command that was sent as waiting, then says the bot did not respond once the time is up", () => {
    const { result } = renderHook(() => useCommandNotices("ch1"));
    act(() => result.current.add(base("i1")));
    expect(kinds(result)).toEqual(["i1:waiting"]);
    act(() => void vi.advanceTimersByTime(DIDNT_RESPOND_MS - 1));
    expect(kinds(result)).toEqual(["i1:waiting"]);
    act(() => void vi.advanceTimersByTime(2));
    expect(kinds(result)).toEqual(["i1:failed"]);
  });

  it("clears the notice when a public answer arrives (a message that names the interaction), and does not fail it afterwards", () => {
    const { result } = renderHook(() => useCommandNotices("ch1"));
    act(() => result.current.add(base("i1")));
    act(() => ws.emit("message:created", { message: { id: "m1", interaction: { id: "i1", command: "request", user: { id: "u", name: "n" } } } }));
    expect(kinds(result)).toEqual([]);
    act(() => void vi.advanceTimersByTime(DIDNT_RESPOND_MS * 2));
    expect(kinds(result)).toEqual([]);
  });

  it("lets go of a notice's timer when it is answered", () => {
    const { result } = renderHook(() => useCommandNotices("ch1"));
    act(() => result.current.add(base("i1")));
    expect(vi.getTimerCount()).toBe(1);
    act(() => ws.emit("message:created", { message: { id: "m1", interaction: { id: "i1", command: "request", user: { id: "u", name: "n" } } } }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits at least as long as the server's five seconds before saying the bot did not respond", () => {
    expect(DIDNT_RESPOND_MS).toBeGreaterThanOrEqual(5000);
  });

  it("is not cleared by an ordinary message, or by a reply to another command", () => {
    const { result } = renderHook(() => useCommandNotices("ch1"));
    act(() => result.current.add(base("i1")));
    act(() => ws.emit("message:created", { message: { id: "m1", interaction: null } }));
    act(() => ws.emit("message:created", { message: { id: "m2" } }));
    act(() => ws.emit("message:created", { message: { id: "m3", interaction: { id: "other", command: "x", user: { id: "u", name: "n" } } } }));
    expect(kinds(result)).toEqual(["i1:waiting"]);
  });

  it("turns into thinking when the bot says so, no longer fails after the short wait, and fails after fifteen minutes", () => {
    const { result } = renderHook(() => useCommandNotices("ch1"));
    act(() => result.current.add(base("i1")));
    act(() => ws.emit("interaction:update", { interactionId: "i1", state: "deferred" }));
    expect(kinds(result)).toEqual(["i1:thinking"]);
    act(() => void vi.advanceTimersByTime(DIDNT_RESPOND_MS * 3));
    expect(kinds(result)).toEqual(["i1:thinking"]);
    act(() => void vi.advanceTimersByTime(THINKING_MS));
    expect(kinds(result)).toEqual(["i1:failed"]);
  });

  it("ignores an update that is not 'deferred'", () => {
    const { result } = renderHook(() => useCommandNotices("ch1"));
    act(() => result.current.add(base("i1")));
    act(() => ws.emit("interaction:update", { interactionId: "i1", state: "something" }));
    expect(kinds(result)).toEqual(["i1:waiting"]);
  });

  it("shows a private reply with its text and cards, in place of the waiting, and stops the timer", () => {
    const { result } = renderHook(() => useCommandNotices("ch1"));
    act(() => result.current.add(base("i1")));
    act(() =>
      ws.emit("interaction:response", { interactionId: "i1", channelId: "ch1", commandName: "request", bot: { displayName: "Robo" }, content: "Only you", richEmbeds: [{ title: "Card" }] })
    );
    expect(result.current.notices).toEqual([{ ...base("i1"), kind: "private", content: "Only you", richEmbeds: [{ title: "Card" }] }]);
    act(() => void vi.advanceTimersByTime(THINKING_MS * 2));
    expect(kinds(result)).toEqual(["i1:private"]);
  });

  it("can be dismissed, and a failure stays until it is", () => {
    const { result } = renderHook(() => useCommandNotices("ch1"));
    act(() => result.current.add(base("i1")));
    act(() => void vi.advanceTimersByTime(DIDNT_RESPOND_MS + 10));
    expect(kinds(result)).toEqual(["i1:failed"]);
    act(() => result.current.dismiss("i1"));
    expect(kinds(result)).toEqual([]);
  });

  it("shows only the channel being looked at, and drops the other channels' when it moves", () => {
    const { result, rerender } = renderHook(({ channelId }) => useCommandNotices(channelId), { initialProps: { channelId: "ch1" } });
    act(() => result.current.add(base("i1", "ch1")));
    act(() => result.current.add(base("i2", "ch2")));
    expect(kinds(result)).toEqual(["i1:waiting"]);
    rerender({ channelId: "ch2" });
    expect(kinds(result)).toEqual(["i2:waiting"]);
    rerender({ channelId: "ch1" });
    expect(kinds(result)).toEqual([]); // ch1's was dropped when ch2 was opened
  });

  it("stops listening and clears its timers when the page goes", () => {
    const { result, unmount } = renderHook(() => useCommandNotices("ch1"));
    act(() => result.current.add(base("i1")));
    unmount();
    expect(ws.handlers.get("interaction:update")?.size ?? 0).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
