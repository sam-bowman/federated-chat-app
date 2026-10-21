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

describe("the first pane", () => {
  it("is the lists on the landing page and on a community on its own, and the page otherwise", () => {
    expect(initialPane("/")).toBe("nav");
    expect(initialPane("/communities/C1")).toBe("nav");
    expect(initialPane("/communities/C1/")).toBe("nav");
    expect(initialPane("/communities/C1/CH1")).toBe("content");
    expect(initialPane("/dm/D1")).toBe("content");
    expect(initialPane("/settings")).toBe("content");
    expect(initialPane("/friends")).toBe("content");
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
