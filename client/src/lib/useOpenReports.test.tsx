import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_REPORTS_EVERY_MS, useOpenReports, waitingLabel } from "./useOpenReports";

const api = vi.hoisted(() => ({ getOpenReportCount: vi.fn() }));
vi.mock("../api", () => api);

/** Lets the answers that are already on their way arrive. */
const settle = () => act(async () => void (await Promise.resolve()));

function hidden(value: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
}

beforeEach(() => {
  vi.useFakeTimers();
  api.getOpenReportCount.mockReset().mockResolvedValue({ open: 3 });
  hidden(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  hidden(false);
});

describe("the number of reports waiting", () => {
  it("is asked when the page opens, for the community it is given, and is null until it arrives", async () => {
    const { result } = renderHook(() => useOpenReports("C1", true));
    expect(result.current.count).toBeNull();
    await settle();

    expect(api.getOpenReportCount).toHaveBeenCalledWith("C1");
    expect(result.current.count).toBe(3);
  });

  it("asks for the admins' when there is no community", async () => {
    renderHook(() => useOpenReports(null, true));
    await settle();
    expect(api.getOpenReportCount).toHaveBeenCalledWith(null);
  });

  it("asks nothing, and says nothing, for someone who cannot review", async () => {
    const { result } = renderHook(() => useOpenReports("C1", false));
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(OPEN_REPORTS_EVERY_MS * 3));

    expect(api.getOpenReportCount).not.toHaveBeenCalled();
    expect(result.current.count).toBeNull();
  });

  it("is asked again every minute, and the new number shows", async () => {
    const { result } = renderHook(() => useOpenReports("C1", true));
    await settle();
    api.getOpenReportCount.mockResolvedValue({ open: 5 });
    await act(() => vi.advanceTimersByTimeAsync(OPEN_REPORTS_EVERY_MS));

    expect(api.getOpenReportCount).toHaveBeenCalledTimes(2);
    expect(result.current.count).toBe(5);
  });

  it("is not asked while the page is hidden, and is asked as soon as it comes back into view or into focus", async () => {
    renderHook(() => useOpenReports("C1", true));
    await settle();
    hidden(true);
    await act(() => vi.advanceTimersByTimeAsync(OPEN_REPORTS_EVERY_MS * 2));
    expect(api.getOpenReportCount).toHaveBeenCalledTimes(1);

    hidden(false);
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(api.getOpenReportCount).toHaveBeenCalledTimes(2);
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(api.getOpenReportCount).toHaveBeenCalledTimes(3);
  });

  it("keeps the last number when asking fails, rather than letting the badge go", async () => {
    const { result } = renderHook(() => useOpenReports("C1", true));
    await settle();
    api.getOpenReportCount.mockRejectedValue(new Error("offline"));
    await act(() => vi.advanceTimersByTimeAsync(OPEN_REPORTS_EVERY_MS));

    expect(api.getOpenReportCount).toHaveBeenCalledTimes(2);
    expect(result.current.count).toBe(3);
  });

  it("never shows one community's number for another", async () => {
    const { result, rerender } = renderHook(({ id }) => useOpenReports(id, true), { initialProps: { id: "C1" } });
    await settle();
    expect(result.current.count).toBe(3);

    api.getOpenReportCount.mockReturnValue(new Promise(() => undefined)); // the next one never answers
    rerender({ id: "C2" });
    expect(result.current.count).toBeNull();
    expect(api.getOpenReportCount).toHaveBeenLastCalledWith("C2");
  });

  it("stops showing the number once the person can no longer review", async () => {
    const { result, rerender } = renderHook(({ on }) => useOpenReports("C1", on), { initialProps: { on: true } });
    await settle();
    expect(result.current.count).toBe(3);

    rerender({ on: false });
    expect(result.current.count).toBeNull();
  });

  it("ignores an answer that arrives after the community was left", async () => {
    let answer: (value: { open: number }) => void = () => undefined;
    api.getOpenReportCount.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { result, rerender } = renderHook(({ id }) => useOpenReports(id, true), { initialProps: { id: "C1" } });
    api.getOpenReportCount.mockResolvedValue({ open: 7 });
    rerender({ id: "C2" });
    await settle();
    expect(result.current.count).toBe(7);

    await act(async () => answer({ open: 99 })); // C1's, late
    expect(result.current.count).toBe(7);
  });

  it("takes the exact number from the queue the moment a report is closed, without asking", async () => {
    const { result } = renderHook(() => useOpenReports("C1", true));
    await settle();
    act(() => result.current.set(2));

    expect(result.current.count).toBe(2);
    expect(api.getOpenReportCount).toHaveBeenCalledTimes(1);
  });

  it("stops asking when the page goes", async () => {
    const { unmount } = renderHook(() => useOpenReports("C1", true));
    await settle();
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(OPEN_REPORTS_EVERY_MS * 2));
    await act(async () => void window.dispatchEvent(new Event("focus")));

    expect(api.getOpenReportCount).toHaveBeenCalledTimes(1);
  });
});

describe("what the badge says", () => {
  it("is singular for one", () => {
    expect(waitingLabel(1)).toBe("1 report");
    expect(waitingLabel(2)).toBe("2 reports");
  });
});
