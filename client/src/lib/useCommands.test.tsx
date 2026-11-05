import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityCommands } from "../api";
import { useCommands } from "./useCommands";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    list: vi.fn(),
    handlers,
    subscribe: (type: string, fn: (payload: unknown) => void) => {
      const set = handlers.get(type) ?? new Set();
      set.add(fn);
      handlers.set(type, set);
      return () => set.delete(fn);
    },
    emit: (type: string, payload?: unknown) => handlers.get(type)?.forEach((fn) => fn(payload)),
  };
});
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), listCommunityCommands: mocks.list }));
// A new `subscribe` each render, as a test double often is: the hook must not ask again because of it.
vi.mock("../context/WsContext", () => ({ useWs: () => ({ subscribe: (type: string, fn: (payload: unknown) => void) => mocks.subscribe(type, fn) }) }));

const set = (names: string[], canUse = true): CommunityCommands => ({ canUse, commands: names.map((n) => ({ id: n, name: n, description: "d", options: [], bot: { id: "b" } as never, botOnline: true })) });

beforeEach(() => {
  mocks.list.mockResolvedValue(set(["ping"]));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.handlers.clear();
});

const names = (r: { current: CommunityCommands }) => r.current.commands.map((c) => c.name);

describe("useCommands", () => {
  it("offers nothing until the community has answered, then what it said", async () => {
    const { result } = renderHook(() => useCommands("C1", true));
    expect(result.current).toEqual({ commands: [], canUse: false });
    await waitFor(() => expect(names(result)).toEqual(["ping"]));
    expect(result.current.canUse).toBe(true);
    expect(mocks.list).toHaveBeenCalledWith("C1");
  });

  it("does not ask at all for a community on another server, or none", () => {
    renderHook(() => useCommands("C1", false));
    renderHook(() => useCommands(null, true));
    renderHook(() => useCommands(undefined, true));
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("asks once when drawn again and again, not once for each draw", async () => {
    const { result, rerender } = renderHook(() => useCommands("C1", true));
    await waitFor(() => expect(names(result)).toEqual(["ping"]));
    rerender();
    rerender();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it.each(["commands:updated", "community:updated", "ws:open"])("asks again on %s, and shows the new set", async (event) => {
    const { result } = renderHook(() => useCommands("C1", true));
    await waitFor(() => expect(names(result)).toEqual(["ping"]));
    mocks.list.mockResolvedValue(set(["ping", "echo"]));
    act(() => mocks.emit(event));
    await waitFor(() => expect(names(result)).toEqual(["ping", "echo"]));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("ignores a community:updated that is about another community", async () => {
    const { result } = renderHook(() => useCommands("C1", true));
    await waitFor(() => expect(names(result)).toEqual(["ping"]));
    act(() => mocks.emit("community:updated", { communityId: "C2" }));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    act(() => mocks.emit("community:updated", { communityId: "C1" }));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("never shows one community's commands in another, and drops an answer that was for the one just left", async () => {
    let resolveFirst: (v: CommunityCommands) => void = () => undefined;
    mocks.list.mockImplementationOnce(() => new Promise<CommunityCommands>((r) => (resolveFirst = r)));
    mocks.list.mockResolvedValueOnce(set(["second"]));
    const { result, rerender } = renderHook(({ id }) => useCommands(id, true), { initialProps: { id: "C1" } });
    rerender({ id: "C2" });
    await waitFor(() => expect(names(result)).toEqual(["second"]));
    resolveFirst(set(["first"]));
    await act(async () => {
      await Promise.resolve();
    });
    expect(names(result)).toEqual(["second"]);
    rerender({ id: "C3" });
    expect(result.current).toEqual({ commands: [], canUse: false }); // C3 has not answered
  });

  it("offers nothing, and does not throw, when it cannot ask", async () => {
    mocks.list.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useCommands("C1", true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual({ commands: [], canUse: false });
  });

  it("stops listening when the page goes", async () => {
    const { unmount, result } = renderHook(() => useCommands("C1", true));
    await waitFor(() => expect(names(result)).toEqual(["ping"]));
    unmount();
    expect(mocks.handlers.get("commands:updated")?.size ?? 0).toBe(0);
  });
});
