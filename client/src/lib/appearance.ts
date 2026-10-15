import { useSyncExternalStore } from "react";

// Display preferences, kept per device (localStorage) and applied to <html> as CSS custom properties:
//   --ui-scale           the whole UI's size (the stylesheet is in rem, and the root font size is 16px times this)
//   --ui-font            the font stack for the whole UI, when a font is chosen for everything
//   --message-font       the font stack for message text and the composer only, when it is chosen for messages only
//   --font-ligatures / --message-ligatures   `normal` or `none`
// index.html runs the same logic in a tiny inline script before the first paint (so there is no flash of the wrong
// size or font); appearanceScript.test.ts runs that real script against this module so they cannot drift.

/** The sizes offered, in percent. 100 is the browser's own default size. */
export const SCALE_STEPS = [75, 90, 100, 110, 125, 150, 175, 200] as const;

export type ScaleSetting = "auto" | number;

export const FONT_CHOICES = ["default", "mono-system", "jetbrains-mono", "ibm-plex-mono", "fira-code", "custom"] as const;
export type FontChoice = (typeof FONT_CHOICES)[number];
export type FontScope = "ui" | "messages";

export interface Appearance {
  /** "auto" picks a size from the screen (see autoScalePercent), or one of SCALE_STEPS. */
  scale: ScaleSetting;
  font: FontChoice;
  /** The name of a font installed on this device, used when `font` is "custom". */
  customFont: string;
  /** Whether the font is for the whole UI or only for messages (and the box you type them in). */
  fontScope: FontScope;
  /** Ligatures (for example -> and != drawn as one symbol) in the fonts that have them. Off by default. */
  ligatures: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = { scale: "auto", font: "default", customFont: "", fontScope: "ui", ligatures: false };

const STORAGE_KEY = "chat.appearance";

// --- Fonts ---

/** The stack the UI has always used. It is also the fallback behind every choice. */
export const DEFAULT_FONT_STACK = '"Segoe UI", system-ui, -apple-system, sans-serif';
/** Monospaced fonts already on the machine (Cascadia Mono ships with Windows 11): nothing is downloaded. */
export const SYSTEM_MONO_STACK = '"Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** The bundled, self-hosted fonts (fonts.css): name for the font stack, and what to show in the picker. */
export const FONT_LABELS: Record<FontChoice, string> = {
  default: "Default",
  "mono-system": "Monospace (system)",
  "jetbrains-mono": "JetBrains Mono",
  "ibm-plex-mono": "IBM Plex Mono",
  "fira-code": "Fira Code",
  custom: "Custom (a font installed on this device)",
};

const BUNDLED_FAMILY: Partial<Record<FontChoice, string>> = {
  "jetbrains-mono": "JetBrains Mono",
  "ibm-plex-mono": "IBM Plex Mono",
  "fira-code": "Fira Code",
};

/** Whether a choice has ligatures worth a toggle: the two coding fonts that draw them, the system monospaces, and a custom font (unknown). */
export function fontHasLigatures(font: FontChoice): boolean {
  return font === "jetbrains-mono" || font === "fira-code" || font === "mono-system" || font === "custom";
}

// A font name goes into a stylesheet, so only letters, digits, spaces and . _ - are accepted: nothing that could end a
// string, a declaration or a rule.
const FONT_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

/** The name as it will be used (trimmed), or null if it is empty, too long or has characters a name should not. */
export function sanitizeFontName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return FONT_NAME.test(name) ? name : null;
}

/** The `font-family` value for an appearance, or null for the default font. */
export function fontStack(appearance: Pick<Appearance, "font" | "customFont">): string | null {
  const { font, customFont } = appearance;
  if (font === "default") return null;
  if (font === "mono-system") return SYSTEM_MONO_STACK;
  if (font === "custom") {
    const name = sanitizeFontName(customFont);
    return name ? `"${name}", ${DEFAULT_FONT_STACK}` : null;
  }
  return `"${BUNDLED_FAMILY[font]}", ${SYSTEM_MONO_STACK}`;
}

// --- Scale ---

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
export function resolveScalePercent(appearance: Pick<Appearance, "scale">, screenWidth: number): number {
  return appearance.scale === "auto" ? autoScalePercent(screenWidth) : appearance.scale;
}

function isScaleStep(value: unknown): value is number {
  return typeof value === "number" && (SCALE_STEPS as readonly number[]).includes(value);
}

function isFontChoice(value: unknown): value is FontChoice {
  return typeof value === "string" && (FONT_CHOICES as readonly string[]).includes(value);
}

/** Reads a stored value, accepting only what this version understands: anything else is the default for that field. */
export function parseAppearance(raw: unknown): Appearance {
  const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const customFont = sanitizeFontName(stored.customFont) ?? "";
  let font = isFontChoice(stored.font) ? stored.font : "default";
  if (font === "custom" && customFont === "") font = "default"; // a custom font needs a usable name
  return {
    scale: isScaleStep(stored.scale) ? stored.scale : "auto",
    font,
    customFont,
    fontScope: stored.fontScope === "messages" ? "messages" : "ui",
    ligatures: stored.ligatures === true,
  };
}

function isDefault(a: Appearance): boolean {
  return (
    a.scale === DEFAULT_APPEARANCE.scale &&
    a.font === DEFAULT_APPEARANCE.font &&
    a.customFont === DEFAULT_APPEARANCE.customFont &&
    a.fontScope === DEFAULT_APPEARANCE.fontScope &&
    a.ligatures === DEFAULT_APPEARANCE.ligatures
  );
}

/** The next size up or down from where the UI is now (for the keyboard shortcuts); stays at the ends. */
export function stepScale(appearance: Appearance, direction: 1 | -1, screenWidth: number): Appearance {
  const now = resolveScalePercent(appearance, screenWidth);
  const steps = [...SCALE_STEPS];
  const next =
    direction === 1 ? steps.find((s) => s > now) ?? steps[steps.length - 1] : [...steps].reverse().find((s) => s < now) ?? steps[0];
  return { ...appearance, scale: next };
}

// --- Storage and applying ---

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
    if (isDefault(appearance)) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...appearance }));
  } catch {
    // Not remembered; it still applies for this visit.
  }
}

function setOrRemove(style: CSSStyleDeclaration, name: string, value: string | null): void {
  if (value === null) style.removeProperty(name);
  else style.setProperty(name, value);
}

/** Puts the settings on <html>, where the stylesheet reads them. */
export function applyAppearance(appearance: Appearance, screenWidth: number = window.screen.width): void {
  const style = document.documentElement.style;
  style.setProperty("--ui-scale", String(resolveScalePercent(appearance, screenWidth) / 100));

  const stack = fontStack(appearance);
  const ligatures = stack !== null && !appearance.ligatures ? "none" : null;
  const wholeUi = appearance.fontScope === "ui";
  setOrRemove(style, "--ui-font", wholeUi ? stack : null);
  setOrRemove(style, "--font-ligatures", wholeUi ? ligatures : null);
  setOrRemove(style, "--message-font", wholeUi ? null : stack);
  setOrRemove(style, "--message-ligatures", wholeUi ? null : ligatures);
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
 * - for smaller, 0 for Auto size. Only the size changes. Only used in the desktop app; in a browser these keys are the
 * browser's own zoom.
 */
export function appearanceForShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  appearance: Appearance,
  screenWidth: number
): Appearance | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.key === "+" || event.key === "=") return stepScale(appearance, 1, screenWidth);
  if (event.key === "-" || event.key === "_") return stepScale(appearance, -1, screenWidth);
  if (event.key === "0") return { ...appearance, scale: "auto" };
  return null;
}
