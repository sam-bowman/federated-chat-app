import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem<Id extends string> {
  id: Id;
  /** What the tab says. Counts ("Friends (3)") are fine: they are read out with the name. */
  label: ReactNode;
}

interface TabsProps<Id extends string> {
  /** Names the group of tabs for assistive technology, for example "Friends". */
  label: string;
  tabs: TabItem<Id>[];
  /** The id of the selected tab. */
  value: Id;
  onChange: (id: Id) => void;
  /** The panel's minimum height, so switching to a shorter tab does not make the page jump. */
  minHeight?: string;
  /** The content of the selected tab: the caller renders it, the panel frames it. */
  children: ReactNode;
}

/**
 * The app's tabs: the strip, and a bordered panel under it that the selected tab opens into.
 * Use it for every set of tabs (a test fails on a hand-made tablist) so the look and the
 * keyboard behaviour can't drift.
 *
 * Keyboard, as in the ARIA authoring practices: Tab moves into the selected tab only (the others
 * are skipped), Left and Right move between tabs and wrap round, Home and End jump to the first
 * and last, and moving to a tab selects it. The content is one tabpanel, labelled by the
 * selected tab.
 */
export default function Tabs<Id extends string>({
  label,
  tabs,
  value,
  onChange,
  minHeight = "12rem",
  children,
}: TabsProps<Id>) {
  const base = useId();
  const buttons = useRef(new Map<Id, HTMLButtonElement>());
  const selected = tabs.some((tab) => tab.id === value) ? value : tabs[0]?.id;
  const tabDomId = (id: Id) => `${base}-tab-${id}`;
  const panelDomId = `${base}-panel`;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    const next = tabs[target];
    onChange(next.id);
    buttons.current.get(next.id)?.focus();
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => {
          const isSelected = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                if (element) buttons.current.set(tab.id, element);
                else buttons.current.delete(tab.id);
              }}
              id={tabDomId(tab.id)}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={panelDomId}
              tabIndex={isSelected ? 0 : -1}
              className={`tab${isSelected ? " active" : ""}`}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        id={panelDomId}
        role="tabpanel"
        aria-labelledby={selected === undefined ? undefined : tabDomId(selected)}
        className="tab-panel"
        style={{ minHeight }}
      >
        {children}
      </div>
    </>
  );
}
