import { describe, expect, it } from "vitest";
import { param } from "./params.js";

describe("param", () => {
  it("reads a named path parameter as the string it is", () => {
    expect(param({ params: { id: "abc", other: "x" } }, "id")).toBe("abc");
  });

  it("refuses a missing one and a list (a wildcard), rather than guess", () => {
    expect(() => param({ params: {} }, "id")).toThrow(/"id" is not a single value/);
    expect(() => param({ params: { id: ["a", "b"] } }, "id")).toThrow(/not a single value/);
  });
});
