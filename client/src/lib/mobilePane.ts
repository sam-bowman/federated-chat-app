import { useSyncExternalStore } from "react";
import { rootFontSize } from "./rootFontSize";

// The phone layout: one pane at a time. The app is three columns (communities, the list of channels or chats, the page), which on a
// phone leaves the page about 130px. Below `NARROW_REM` wide the person sees either the lists ("nav") or the page ("content"), and a
// Back bar returns to the lists. The breakpoint is measured in rem (that is, against the UI scale) in JavaScript, because a rem in
// a CSS media query is the browser's own 16px and would ignore the scale.

/** Narrower than this many rem (640px at the normal size) gets one pane at a time. */
export const NARROW_REM = 40;

export type Pane = "nav" | "content";

export function isNarrow(width: number, rootPx: number): boolean {
  return width < NARROW_REM * rootPx;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
  };
}

/** True while the window is narrow enough for one pane at a time. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isNarrow(window.innerWidth, rootFontSize()),
    () => false
  );
}

/**
 * Which pane to show when there is no earlier choice to go by: at the start, and when a window becomes narrow (it was resized, or
 * the UI scale went up) while somewhere. The lists on the landing page and on a community on its own, otherwise the page.
 */
export function initialPane(pathname: string): Pane {
  return pathname === "/" || /^\/communities\/[^/]+\/?$/.test(pathname) ? "nav" : "content";
}

/**
 * Which pane a change of address leads to, when the person did not pick one by tapping. The first page after the landing redirect,
 * and a community on its own (its list of channels), are lists; every other address is a page to read.
 */
export function paneAfterNavigation(previous: string, next: string): Pane {
  if (previous === "/") return "nav";
  if (/^\/communities\/[^/]+\/?$/.test(next)) return "nav";
  return "content";
}
