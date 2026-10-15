// Colour maths for the colour picker (components/ColourPickerModal.tsx). Colours are always
// "#rrggbb" in lower case, which is what the server accepts for a role colour.

export interface Hsv {
  /** Hue, 0 to 360 degrees. */
  h: number;
  /** Saturation, 0 to 100. */
  s: number;
  /** Value (brightness), 0 to 100. */
  v: number;
}

const HEX6 = /^#[0-9a-f]{6}$/;

/** True for exactly "#rrggbb" (either case): the only shape the server stores. */
export function isHexColour(value: string): boolean {
  return HEX6.test(value.toLowerCase());
}

/**
 * Reads what a person might type into a hex field: with or without the "#", in either case, and
 * the short "#rgb" form. Returns "#rrggbb" in lower case, or null if it is not a complete colour.
 */
export function parseHexInput(input: string): string | null {
  const digits = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(digits)) {
    return "#" + digits.split("").map((d) => d + d).join("");
  }
  return /^[0-9a-f]{6}$/.test(digits) ? "#" + digits : null;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channelHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + channelHex(r) + channelHex(g) + channelHex(b);
}

export function hexToHsv(hex: string): Hsv {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h), s: Math.round(max === 0 ? 0 : (delta / max) * 100), v: Math.round(max * 100) };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const sat = s / 100;
  const val = v / 100;
  const chroma = val * sat;
  const sector = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r1, g1, b1] =
    sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x]
    : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const m = val - chroma;
  return rgbToHex((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
}

/** Position in the saturation/brightness square to the two values: left to right is saturation, bottom to top is brightness. */
export function squareToSv(x: number, y: number): { s: number; v: number } {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return { s: Math.round(clamp(x) * 100), v: Math.round((1 - clamp(y)) * 100) };
}

/** The sidebar background (--bg-1 in index.css; colour.test.ts checks they agree): what a role colour is shown against. */
export const SIDEBAR_BACKGROUND = "#262730";

/** The colours offered first: well spaced, each readable on the dark sidebar (colour.test.ts checks it), and the app's own accent among them. */
export const COLOUR_PRESETS: { name: string; hex: string }[] = [
  { name: "Indigo", hex: "#6c7cff" },
  { name: "Blue", hex: "#3b9cf5" },
  { name: "Teal", hex: "#1fb5a7" },
  { name: "Green", hex: "#3bc47e" },
  { name: "Lime", hex: "#a3d440" },
  { name: "Gold", hex: "#e8b84b" },
  { name: "Orange", hex: "#f08a3c" },
  { name: "Red", hex: "#e5556a" },
  { name: "Pink", hex: "#e45cb0" },
  { name: "Purple", hex: "#a66cf0" },
  { name: "Grey", hex: "#99aab5" },
  { name: "White", hex: "#e7e7ea" },
];
