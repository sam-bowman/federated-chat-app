import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, SCALE_STEPS, getAppearance, setAppearance, startAppearance } from "../lib/appearance";
import AppearanceSection from "./AppearanceSection";

function screenWidth(width: number) {
  Object.defineProperty(window.screen, "width", { value: width, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("--ui-scale");
  screenWidth(1920);
  startAppearance();
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  screenWidth(0);
});

const pressed = () => screen.getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true");
const scale = () => document.documentElement.style.getPropertyValue("--ui-scale");

describe("Settings -> Appearance -> Interface size", () => {
  it("offers Auto and every size, as a labelled group of toggle buttons", () => {
    render(<AppearanceSection />);

    expect(screen.getByRole("group", { name: "Interface size" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Auto/ })).toBeTruthy();
    for (const step of SCALE_STEPS) expect(screen.getByRole("button", { name: `${step}%` })).toBeTruthy();
  });

  it("starts on Auto, and says what Auto is for this screen", () => {
    screenWidth(3840);
    render(<AppearanceSection />);

    expect(pressed().map((b) => b.textContent)).toEqual(["Auto (150%)"]);
  });

  it("applies a chosen size at once, marks it, and remembers it on this device", () => {
    render(<AppearanceSection />);

    fireEvent.click(screen.getByRole("button", { name: "150%" }));

    expect(scale()).toBe("1.5");
    expect(pressed().map((b) => b.textContent)).toEqual(["150%"]);
    expect(JSON.parse(localStorage.getItem("chat.appearance")!)).toMatchObject({ v: 1, scale: 150 });
  });

  it("goes back to Auto, and forgets the stored choice", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("button", { name: "200%" }));

    fireEvent.click(screen.getByRole("button", { name: /^Auto/ }));

    expect(scale()).toBe("1");
    expect(localStorage.getItem("chat.appearance")).toBeNull();
    expect(pressed().map((b) => b.textContent)).toEqual(["Auto (100%)"]);
  });

  it("shows a size chosen elsewhere (another tab, or a keyboard shortcut) as the pressed one", () => {
    render(<AppearanceSection />);

    act(() => setAppearance({ ...DEFAULT_APPEARANCE, scale: 75 }));

    expect(pressed().map((b) => b.textContent)).toEqual(["75%"]);
  });

  it("mentions the keyboard shortcuts only in the desktop app, where they exist", () => {
    const { unmount } = render(<AppearanceSection />);
    expect(screen.queryByText(/Ctrl and \+/)).toBeNull();
    unmount();

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    render(<AppearanceSection />);

    expect(screen.getByText(/Ctrl and \+/)).toBeTruthy();
  });

  it("keeps the choice stored as it was chosen, whatever the screen is", () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole("button", { name: "125%" }));
    screenWidth(3840);

    expect(getAppearance().scale).toEqual(125);
  });
});
