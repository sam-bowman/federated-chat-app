import { describe, expect, it } from "vitest";
import { NARROW_REM, initialPane, isNarrow, paneAfterNavigation } from "./mobilePane";

describe("when the window is narrow", () => {
  it("is narrower than 40rem, so a phone is and a tablet is not", () => {
    expect(NARROW_REM).toBe(40);
    expect(isNarrow(375, 16)).toBe(true);
    expect(isNarrow(639, 16)).toBe(true);
    expect(isNarrow(640, 16)).toBe(false);
    expect(isNarrow(768, 16)).toBe(false);
  });

  it("follows the UI scale: the same window is narrow when everything is bigger", () => {
    expect(isNarrow(900, 16)).toBe(false);
    expect(isNarrow(900, 32)).toBe(true); // 200%: 900px is 28rem
    expect(isNarrow(1200, 24)).toBe(false); // 150%: 50rem
  });
});

import { renderHook } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { useVisibleHeight } from "./mobilePane";

describe("the visible height (the on-screen keyboard)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty("--app-height");
  });

  function fakeViewport(height: number, offsetTop = 0) {
    const listeners = new Map<string, () => void>();
    const viewport = {
      height,
      offsetTop,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    vi.stubGlobal("visualViewport", viewport);
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    return { viewport, fire: (type: string) => listeners.get(type)?.() };
  }

  it("makes the page as tall as what can be seen, and follows the keyboard coming and going", () => {
    const { viewport, fire } = fakeViewport(667);
    renderHook(() => useVisibleHeight(true));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("667px");
    viewport.height = 380; // the keyboard opens
    fire("resize");
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("380px");
  });

  it("scrolls the page back to the top if the browser panned it up to make room", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    fakeViewport(400, 120);
    renderHook(() => useVisibleHeight(true));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    scrollTo.mockRestore();
  });

  it("does nothing on a wide window, and puts everything back when it stops", () => {
    fakeViewport(667);
    const wide = renderHook(() => useVisibleHeight(false));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
    wide.unmount();
    const narrow = renderHook(() => useVisibleHeight(true));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("667px");
    narrow.unmount();
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
  });
});

describe("the first pane", () => {
  it("is the lists on the landing page and on a community on its own, and the page otherwise", () => {
    expect(initialPane("/")).toBe("nav");
    expect(initialPane("/communities/C1")).toBe("nav");
    expect(initialPane("/communities/C1/")).toBe("nav");
    expect(initialPane("/communities/C1/CH1")).toBe("content");
    expect(initialPane("/dm/D1")).toBe("content");
    expect(initialPane("/settings")).toBe("content");
    expect(initialPane("/friends")).toBe("nav"); // where signing in lands
    expect(initialPane("/browse")).toBe("content");
  });
});

describe("the pane after an address change nobody tapped", () => {
  it("keeps the lists for the first page after the landing redirect, whatever it is", () => {
    expect(paneAfterNavigation("/", "/friends")).toBe("nav");
  });
  it("shows the lists of a community opened on its own, and the page for anything more specific", () => {
    expect(paneAfterNavigation("/friends", "/communities/C1")).toBe("nav");
    expect(paneAfterNavigation("/friends", "/communities/C1/CH1")).toBe("content");
    expect(paneAfterNavigation("/communities/C1", "/dm/D1")).toBe("content");
    expect(paneAfterNavigation("/dm/D1", "/settings")).toBe("content");
  });
});
