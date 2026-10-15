import { describe, expect, it } from "vitest";
import type { Message } from "../api";
import { withArrivals } from "./arrivals";

const m = (id: string, content = id) => ({ id, content }) as Message;

describe("withArrivals", () => {
  it("is the history itself when nothing arrived", () => {
    const page = [m("a")];
    expect(withArrivals(page, [])).toBe(page);
  });

  it("appends what arrived and the history does not hold, in arrival order", () => {
    expect(withArrivals([m("a")], [m("c"), m("b")]).map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("keeps the history's copy of a message it already holds", () => {
    const merged = withArrivals([m("a", "edited")], [m("a", "original")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe("edited");
  });
});
