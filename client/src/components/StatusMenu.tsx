import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PRESENCE_OPTIONS, type PresenceStatus } from "../lib/presence";
import CustomStatusForm from "./CustomStatusForm";
import PresenceDot from "./PresenceDot";

/** What marks an element that opens this menu: pressing it is its own toggle, not "a click outside". */
export const STATUS_MENU_TRIGGER_ATTRIBUTE = "data-status-menu-trigger";

interface Props {
  status: string;
  customStatus: string | null;
  onSetStatus: (status: PresenceStatus) => Promise<void>;
  onSetCustomStatus: (next: string | null) => Promise<void>;
  /** Closes the menu. `restoreFocus` is true for Escape and a finished choice, false for a click elsewhere. */
  onClose: (restoreFocus: boolean) => void;
}

/**
 * Set your own status from the footer: the five statuses as a menu (arrow keys move, Enter or Space
 * picks), and the custom status below it. Choosing a status applies it at once and closes the menu;
 * Escape closes it and focus goes back to what opened it (the footer does that). It is a small dialog
 * around a menu, not a menu alone, because a text field is not a menu item.
 */
export default function StatusMenu({ status, customStatus, onSetStatus, onSetCustomStatus, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checkedIndex = Math.max(
    0,
    PRESENCE_OPTIONS.findIndex((o) => o.value === status)
  );

  // Focus the current status when it opens, so a keyboard user starts where they are.
  useEffect(() => {
    items.current[checkedIndex]?.focus();
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A press anywhere outside the menu and the controls that open it closes it.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Element;
      if (root.current?.contains(target)) return;
      if (target.closest?.(`[${STATUS_MENU_TRIGGER_ATTRIBUTE}]`)) return;
      onClose(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    }
  }

  function onItemKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = PRESENCE_OPTIONS.length - 1;
    const target =
      event.key === "ArrowDown"
        ? (index + 1) % PRESENCE_OPTIONS.length
        : event.key === "ArrowUp"
          ? (index - 1 + PRESENCE_OPTIONS.length) % PRESENCE_OPTIONS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    items.current[target]?.focus();
  }

  async function choose(value: PresenceStatus) {
    if (value === status) {
      onClose(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSetStatus(value);
      onClose(true);
    } catch {
      setError("Couldn't change your status.");
      setBusy(false);
    }
  }

  return (
    <div ref={root} className="status-menu" role="dialog" aria-label="Set your status" onKeyDown={onKeyDown}>
      <div role="menu" aria-label="Status">
        {PRESENCE_OPTIONS.map((option, index) => {
          const checked = option.value === status;
          return (
            <button
              key={option.value}
              ref={(element) => {
                items.current[index] = element;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              tabIndex={index === checkedIndex ? 0 : -1}
              disabled={busy}
              className="status-option"
              onClick={() => void choose(option.value)}
              onKeyDown={(event) => onItemKeyDown(event, index)}
            >
              <PresenceDot status={option.value} decorative />
              <span className="status-option-text">
                <span className="status-option-label">{option.label}</span>
                <span className="status-option-description">{option.description}</span>
              </span>
              {checked && <span aria-hidden="true">✓</span>}
            </button>
          );
        })}
      </div>

      <div className="status-menu-custom">
        <div className="status-menu-heading">Custom status</div>
        <CustomStatusForm
          key={customStatus ?? ""}
          current={customStatus}
          onSave={onSetCustomStatus}
          onSaved={() => onClose(true)}
        />
      </div>

      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
