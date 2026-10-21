import { describe, expect, it } from "vitest";
import { literally } from "./likeSearch.js";

describe("literally", () => {
  it("escapes the three characters LIKE treats specially, and nothing else", () => {
    expect(literally("100%")).toBe("100\\%");
    expect(literally("a_b")).toBe("a\\_b");
    expect(literally("back\\slash")).toBe("back\\\\slash");
    expect(literally("%_\\")).toBe("\\%\\_\\\\");
  });

  it("leaves an ordinary search alone", () => {
    for (const q of ["alice", "Bob B", "o'brien", "x-y.z", "é日本", ""]) expect(literally(q)).toBe(q);
  });
});
