import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import {
  SIDEBAR_DEFAULT_REM,
  SIDEBAR_MAX_REM,
  SIDEBAR_MIN_REM,
  SIDEBAR_STEP_REM,
  clampSidebarWidth,
} from "../lib/sidebarWidth";

interface Props {
  /** The sidebar's width now, in rem. */
  width: number;
  /** Called as the width changes (while dragging, or on each key press). */
  onChange: (rem: number) => void;
  /** Called once a change is finished, with the final width: the place to remember it. */
  onCommit: (rem: number) => void;
  /** Called on a double click: back to the default (and forget the remembered width). */
  onReset: () => void;
}

function rootFontSize(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * The draggable edge between the sidebar and the page. It is a separator you can also move from the keyboard
 * (Left and Right by a rem, Home and End for the narrowest and widest), and a double click puts it back.
 * It sits over the shell's grid, not in it, so it takes no room of its own.
 */
export default function SidebarResizer({ width, onChange, onCommit, onReset }: Props) {
  const dragging = useRef(false);
  // The width the drag has reached, so releasing remembers it without waiting for a re-render.
  const latest = useRef(width);

  function widthAt(event: PointerEvent<HTMLElement>): number {
    // The sidebar starts after the 4.5rem rail, measured from the shell's own left edge.
    const shell = event.currentTarget.parentElement!.getBoundingClientRect();
    const rem = rootFontSize();
    return clampSidebarWidth((event.clientX - shell.left) / rem - 4.5);
  }

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    dragging.current = true;
    latest.current = width;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    if (!dragging.current) return;
    const next = widthAt(event);
    latest.current = next;
    onChange(next);
  }

  function finish() {
    if (!dragging.current) return;
    dragging.current = false;
    onCommit(latest.current);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const next =
      event.key === "ArrowRight"
        ? width + SIDEBAR_STEP_REM
        : event.key === "ArrowLeft"
          ? width - SIDEBAR_STEP_REM
          : event.key === "Home"
            ? SIDEBAR_MIN_REM
            : event.key === "End"
              ? SIDEBAR_MAX_REM
              : null;
    if (next === null) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(next);
    onChange(clamped);
    onCommit(clamped);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuemin={SIDEBAR_MIN_REM}
      aria-valuemax={SIDEBAR_MAX_REM}
      aria-valuenow={width}
      aria-valuetext={`${width} rem wide${width === SIDEBAR_DEFAULT_REM ? " (default)" : ""}`}
      tabIndex={0}
      className="sidebar-resizer"
      title="Drag to resize; double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
