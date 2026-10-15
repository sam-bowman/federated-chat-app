import { describe, expect, it, vi } from "vitest";
import { runShutdown } from "./shutdown.js";

describe("runShutdown", () => {
  it("runs the steps in order, waiting for each", async () => {
    const order: string[] = [];
    await runShutdown(
      [
        {
          name: "slow",
          run: async () => {
            await new Promise((r) => setTimeout(r, 20));
            order.push("slow");
          },
        },
        { name: "fast", run: () => void order.push("fast") },
      ],
      1000,
      { error: vi.fn() }
    );

    expect(order).toEqual(["slow", "fast"]);
  });

  it("carries on after a step that throws, and says which one", async () => {
    const error = vi.fn();
    const after = vi.fn();
    await runShutdown(
      [
        { name: "broken", run: () => Promise.reject(new Error("boom")) },
        { name: "after", run: after },
      ],
      1000,
      { error }
    );

    expect(after).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("[shutdown] broken failed:", "boom");
  });

  // A client that never answers a close frame, or a request that never ends, must not hold the
  // process (and the pod's termination) hostage.
  it("gives up on a step that never finishes and moves on", async () => {
    const error = vi.fn();
    const after = vi.fn();
    await runShutdown(
      [
        { name: "stuck", run: () => new Promise(() => {}) },
        { name: "after", run: after },
      ],
      30,
      { error }
    );

    expect(after).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toBe("[shutdown] stuck failed:");
    expect(String(error.mock.calls[0][1])).toContain("timed out after 30 ms");
  });
});
