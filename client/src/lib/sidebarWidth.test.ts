import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_DEFAULT_REM,
  SIDEBAR_MAX_REM,
  SIDEBAR_MIN_REM,
  clampSidebarWidth,
  forgetSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from "./sidebarWidth";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("clampSidebarWidth", () => {
  it("keeps a width in range, to a quarter of a rem", () => {
    expect(clampSidebarWidth(20)).toBe(20);
    expect(clampSidebarWidth(18.37)).toBe(18.25);
    expect(clampSidebarWidth(18.4)).toBe(18.5);
  });

  it("stops at the smallest and largest", () => {
    expect(clampSidebarWidth(2)).toBe(SIDEBAR_MIN_REM);
    expect(clampSidebarWidth(500)).toBe(SIDEBAR_MAX_REM);
    expect(clampSidebarWidth(-5)).toBe(SIDEBAR_MIN_REM);
  });

  it.each([NaN, Infinity, -Infinity])("gives the default for %s", (value) => {
    expect(clampSidebarWidth(value)).toBe(SIDEBAR_DEFAULT_REM);
  });

  it("has a default inside its own range", () => {
    expect(SIDEBAR_DEFAULT_REM).toBeGreaterThanOrEqual(SIDEBAR_MIN_REM);
    expect(SIDEBAR_DEFAULT_REM).toBeLessThanOrEqual(SIDEBAR_MAX_REM);
  });
});

describe("remembering the width", () => {
  it("is the default until one is saved", () => {
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_REM);
  });

  it("brings back what was saved", () => {
    saveSidebarWidth(24);

    expect(loadSidebarWidth()).toBe(24);
  });

  it("saves only an allowed width", () => {
    saveSidebarWidth(900);

    expect(loadSidebarWidth()).toBe(SIDEBAR_MAX_REM);
  });

  it.each(["", "wide", "NaN", "Infinity"])("falls back to the default for a stored %j", (stored) => {
    localStorage.setItem("chat.sidebarWidth", stored);

    expect(loadSidebarWidth()).toBe(stored === "" ? SIDEBAR_MIN_REM : SIDEBAR_DEFAULT_REM);
  });

  it("clamps a stored width that is out of range (an old version, a hand edit)", () => {
    localStorage.setItem("chat.sidebarWidth", "3");

    expect(loadSidebarWidth()).toBe(SIDEBAR_MIN_REM);
  });

  it("forgets it, going back to the default", () => {
    saveSidebarWidth(24);

    forgetSidebarWidth();

    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_REM);
  });

  it("does not throw when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_REM);
    expect(() => saveSidebarWidth(24)).not.toThrow();
    expect(() => forgetSidebarWidth()).not.toThrow();
  });
});
