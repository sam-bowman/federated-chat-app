import { useSyncExternalStore } from "react";

// Display preferences, kept per device (localStorage) and applied to <html> as CSS custom properties. The
// stylesheet is in rem and `:root { font-size: calc(16px * var(--ui-scale, 1)) }`, so changing --ui-scale scales the
// whole UI together. index.html runs the same logic in a tiny inline script before the first paint (so there is no
// flash of the wrong size); appearanceScript.test.ts runs that real script against this module so they cannot drift.

/** The sizes offered, in percent. 100 is the browser's own default size. */
export const SCALE_STEPS = [75, 90, 100, 110, 125, 150, 175, 200] as const;

export type ScaleSetting = "auto" | number;

export interface Appearance {
  /** "auto" picks a size from the screen (see autoScalePercent), or one of SCALE_STEPS. */
  scale: ScaleSetting;
}

export const DEFAULT_APPEARANCE: Appearance = { scale: "auto" };

const STORAGE_KEY = "chat.appearance";

/**
 * The size "Auto" chooses for a screen `screenWidth` CSS pixels wide (screen.width, which already has the system's own
 * display scaling folded in, so a 4K monitor at 150% system scaling reports 2560 and is left alone). The UI is
 * designed for a laptop-sized screen; a 1440p monitor at 100% system scaling (2560) and a 4K one (3840) otherwise
 * show it small. Measured on the screen, not the window, so resizing the window never changes the size.
 */
export function autoScalePercent(screenWidth: number): number {
  if (screenWidth >= 3200) return 150;
  if (screenWidth >= 2400) return 125;
  return 100;
}

/** The percent actually in effect for a setting. */
export function resolveScalePercent(appearance: Appearance, screenWidth: number): number {
  return appearance.scale === "auto" ? autoScalePercent(screenWidth) : appearance.scale;
}

function isScaleStep(value: unknown): value is number {
  return typeof value === "number" && (SCALE_STEPS as readonly number[]).includes(value);
}

/** Reads a stored value, accepting only what this version understands: anything else is the default. */
export function parseAppearance(raw: unknown): Appearance {
  const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return { scale: isScaleStep(stored.scale) ? stored.scale : "auto" };
}

/** The next size up or down from where the UI is now (for the keyboard shortcuts); stays at the ends. */
export function stepScale(appearance: Appearance, direction: 1 | -1, screenWidth: number): Appearance {
  const now = resolveScalePercent(appearance, screenWidth);
  const steps = [...SCALE_STEPS];
  const next =
    direction === 1 ? steps.find((s) => s > now) ?? steps[steps.length - 1] : [...steps].reverse().find((s) => s < now) ?? steps[0];
  return { ...appearance, scale: next };
}

export function loadAppearance(): Appearance {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? DEFAULT_APPEARANCE : parseAppearance(JSON.parse(stored));
  } catch {
    // Blocked storage or a damaged value: the defaults.
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(appearance: Appearance): void {
  try {
    if (appearance.scale === DEFAULT_APPEARANCE.scale) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, scale: appearance.scale }));
  } catch {
    // Not remembered; it still applies for this visit.
  }
}

/** Puts the settings on <html>, where the stylesheet reads them. */
export function applyAppearance(appearance: Appearance, screenWidth: number = window.screen.width): void {
  document.documentElement.style.setProperty("--ui-scale", String(resolveScalePercent(appearance, screenWidth) / 100));
}

// --- A small store, so the settings page re-renders when the appearance changes (here or in another tab). ---

let current: Appearance | null = null;
const listeners = new Set<() => void>();

export function getAppearance(): Appearance {
  if (current === null) current = loadAppearance();
  return current;
}

export function setAppearance(next: Appearance): void {
  current = next;
  saveAppearance(next);
  applyAppearance(next);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current appearance, and a way to change it. */
export function useAppearance(): [Appearance, (next: Appearance) => void] {
  return [useSyncExternalStore(subscribe, getAppearance), setAppearance];
}

/** Applies the stored appearance at startup and follows changes made in another tab or window. */
export function startAppearance(): void {
  current = loadAppearance();
  applyAppearance(current);
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    current = loadAppearance();
    applyAppearance(current);
    listeners.forEach((listener) => listener());
  });
}

/** Whether this is the desktop app (a Tauri webview), where the browser's own zoom keys may not exist. */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The appearance a keyboard shortcut asks for, or null if the key is not one: Ctrl/Cmd and + (or =) for larger,
 * - for smaller, 0 for Auto. Only used in the desktop app; in a browser these keys are the browser's own zoom.
 */
export function appearanceForShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  appearance: Appearance,
  screenWidth: number
): Appearance | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.key === "+" || event.key === "=") return stepScale(appearance, 1, screenWidth);
  if (event.key === "-" || event.key === "_") return stepScale(appearance, -1, screenWidth);
  if (event.key === "0") return DEFAULT_APPEARANCE;
  return null;
}
