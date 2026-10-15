import { useEffect, useId, useRef, type ReactNode } from "react";
import Button from "./Button";

const DIALOG_ATTRIBUTE = "data-modal-dialog";

// Anything a keyboard can land on. Tab order is decided below by `tabIndex`, which also drops
// elements set to -1 (the inactive tabs in a tablist, a hidden file input).
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0 && !element.hasAttribute("disabled") && !element.hasAttribute("hidden")
  );
}

/**
 * A dialog over the page. For people on a keyboard or a screen reader it behaves like one:
 *  - it is announced as a dialog with the title as its name;
 *  - focus moves into it when it opens (unless something inside already took it, like an
 *    autoFocus field) and goes back to what had it, usually the button that opened it, when it closes;
 *  - Tab and Shift+Tab stay inside it;
 *  - Escape closes it, and only the topmost one when modals are stacked (a confirmation over a
 *    settings dialog, the colour picker over the role editor).
 * Clicking the dimmed backdrop closes it too.
 */
export default function Modal({
  title,
  onClose,
  children,
  width = 400,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** The dialog's width in pixels at 100% UI scale; it is applied in rem, so it grows with the scale. */
  width?: number;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // The latest onClose without re-running the effect below (which would move focus again).
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!node.contains(document.activeElement)) (focusableIn(node)[0] ?? node).focus();

    // Which modal is on top is decided by the page, not by mount order: a modal inside another
    // one runs its effects first, but sits later in the document.
    const isTopmost = () => {
      const all = document.querySelectorAll(`[${DIALOG_ATTRIBUTE}]`);
      return all[all.length - 1] === node;
    };

    function onKeyDown(event: KeyboardEvent) {
      if (!node || !isTopmost()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableIn(node);
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!node.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={(event) => {
        // Only a click on the backdrop itself: one that starts in the dialog and ends outside it
        // (selecting text) lands on the dialog's own ancestors and is not this.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        {...{ [DIALOG_ATTRIBUTE]: "" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="auth-card"
        style={{ width: `${width / 16}rem`, maxWidth: "calc(100vw - 2rem)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h1 id={titleId} style={{ fontSize: "1.125rem" }}>
            {title}
          </h1>
          <Button onClick={onClose} variant="secondary" size="sm" aria-label="Close dialog">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
