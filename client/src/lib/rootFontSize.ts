/**
 * The size of 1rem in pixels right now, which is 16 times the UI scale. The stylesheet is in rem so it follows the
 * scale by itself; this is for the few places that must do arithmetic with real pixels (positioning a popover from a
 * button's rectangle, turning a pointer position into a width).
 */
export function rootFontSize(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}
