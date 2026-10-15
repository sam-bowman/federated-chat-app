// The width of the left sidebar, in rem so it follows the root font size (and, later, the UI scale setting).
// The person can drag its edge; the width is remembered on this device.

export const SIDEBAR_DEFAULT_REM = 20;
export const SIDEBAR_MIN_REM = 14;
export const SIDEBAR_MAX_REM = 32;
/** How far an arrow key moves the edge, in rem. */
export const SIDEBAR_STEP_REM = 1;

const STORAGE_KEY = "chat.sidebarWidth";

/** The nearest allowed width, to a quarter of a rem. A value that is not a number gives the default. */
export function clampSidebarWidth(rem: number): number {
  if (!Number.isFinite(rem)) return SIDEBAR_DEFAULT_REM;
  const clamped = Math.min(SIDEBAR_MAX_REM, Math.max(SIDEBAR_MIN_REM, rem));
  return Math.round(clamped * 4) / 4;
}

/** The remembered width, or the default if there is none or it is unreadable. Storage can be blocked, so it never throws. */
export function loadSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return SIDEBAR_DEFAULT_REM;
    return clampSidebarWidth(Number(stored));
  } catch {
    return SIDEBAR_DEFAULT_REM;
  }
}

export function saveSidebarWidth(rem: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampSidebarWidth(rem)));
  } catch {
    // Not remembered; the width still applies for this visit.
  }
}

export function forgetSidebarWidth(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored to forget.
  }
}
