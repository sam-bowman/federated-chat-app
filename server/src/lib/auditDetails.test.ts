import { describe, expect, it } from "vitest";
import { MAX_DETAIL_KEYS, MAX_LIST_ITEMS, MAX_STRING_LENGTH, sanitizeDetails, sanitizeLabel } from "./auditDetails.js";

describe("sanitizeDetails", () => {
  it("keeps strings, numbers, booleans, null and lists of strings", () => {
    expect(sanitizeDetails({ role: "Mods", count: 3, silent: true, was: null, fields: ["name", "visibility"] })).toEqual({
      role: "Mods",
      count: 3,
      silent: true,
      was: null,
      fields: ["name", "visibility"],
    });
  });

  it("is null when there is nothing to keep", () => {
    expect(sanitizeDetails(undefined)).toBeNull();
    expect(sanitizeDetails(null)).toBeNull();
    expect(sanitizeDetails({})).toBeNull();
    expect(sanitizeDetails({ nested: { a: 1 } as unknown as string })).toBeNull();
  });

  it("drops what is not a plain value, instead of turning it into something that looks like one", () => {
    const out = sanitizeDetails({ ok: "yes", object: { a: 1 }, fn: () => 1, nan: NaN, inf: Infinity, mixed: ["a", 2], undef: undefined });
    expect(out).toEqual({ ok: "yes" });
  });

  it("drops keys that are not plain names, and caps how many there are", () => {
    expect(sanitizeDetails({ "has space": 1, "9starts": 1, "": 1, "a.b": 1, fine_1: 1 })).toEqual({ fine_1: 1 });
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeDetails(many)!)).toHaveLength(MAX_DETAIL_KEYS);
    expect(sanitizeDetails({ [`k${"x".repeat(60)}`]: 1 })).toBeNull();
  });

  it("cuts long strings and lists, ending a cut string in an ellipsis", () => {
    const out = sanitizeDetails({ text: "x".repeat(500), list: Array.from({ length: 50 }, (_, i) => `item${i}`) })!;
    expect([...(out.text as string)]).toHaveLength(MAX_STRING_LENGTH);
    expect((out.text as string).endsWith("…")).toBe(true);
    expect(out.list).toHaveLength(MAX_LIST_ITEMS);
  });

  it("takes control and bidirectional characters out of text, so a label cannot be reordered", () => {
    const out = sanitizeDetails({ name: "evil‮exe.txt\u0000x", list: ["a​b"] })!;
    expect(out.name).toBe("evil exe.txt x");
    expect(out.list).toEqual(["a b"]);
  });
});

describe("sanitizeLabel", () => {
  it("is one short clean line, or null", () => {
    expect(sanitizeLabel("  @alice:chat.example  ")).toBe("@alice:chat.example");
    expect(sanitizeLabel("a\nb")).toBe("a b");
    expect(sanitizeLabel("")).toBeNull();
    expect(sanitizeLabel("   ")).toBeNull();
    expect(sanitizeLabel(null)).toBeNull();
    expect(sanitizeLabel(undefined)).toBeNull();
    expect([...sanitizeLabel("y".repeat(400))!]).toHaveLength(MAX_STRING_LENGTH);
  });
});
