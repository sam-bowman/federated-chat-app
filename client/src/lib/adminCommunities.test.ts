import { describe, expect, it } from "vitest";
import { nameConfirmed } from "./adminCommunities";

describe("nameConfirmed", () => {
  it("is the name, in any case, with the spaces at both ends taken off (as the server judges it)", () => {
    expect(nameConfirmed("Book Club", "Book Club")).toBe(true);
    expect(nameConfirmed("  book CLUB ", "Book Club")).toBe(true);
    expect(nameConfirmed("Book Club", " Book Club ")).toBe(true);
  });

  it("is not part of it, or more than it, or it with another spacing inside", () => {
    expect(nameConfirmed("", "Book Club")).toBe(false);
    expect(nameConfirmed("Book", "Book Club")).toBe(false);
    expect(nameConfirmed("Book Club!", "Book Club")).toBe(false);
    expect(nameConfirmed("Book  Club", "Book Club")).toBe(false);
    expect(nameConfirmed("BookClub", "Book Club")).toBe(false);
  });

  it("does not take other text for a name that is nothing but spaces", () => {
    expect(nameConfirmed("x", "   ")).toBe(false);
  });
});
