import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadEmojiGroups, searchEmoji, type EmojiGroup } from "../lib/emojiData";
import { noAutofill } from "../lib/noAutofill";
import { rootFontSize } from "../lib/rootFontSize";
import { getRecentEmoji, rememberEmoji } from "../lib/recentEmoji";
import Button from "./Button";

/** Elements that open the picker mark themselves with this, so their own click isn't treated as "outside". */
export const EMOJI_PICKER_TRIGGER_ATTR = "data-emoji-picker-trigger";

interface Props {
  /** Called with the chosen emoji. The picker records it as recent but does not close itself. */
  onPick: (emoji: string) => void;
  onClose: () => void;
}

type Status = { state: "loading" } | { state: "error" } | { state: "ready"; groups: EmojiGroup[] };

// Nearest cell above or below `current`, preferring the one closest in column. Layout-based, so it
// copes with the section breaks and the shorter last row of each category.
function verticalNeighbour(cells: HTMLElement[], current: HTMLElement, direction: 1 | -1): HTMLElement | null {
  const here = current.getBoundingClientRect();
  const centre = here.left + here.width / 2;
  let best: HTMLElement | null = null;
  let bestRow = Infinity;
  let bestColumn = Infinity;
  for (const cell of cells) {
    const r = cell.getBoundingClientRect();
    const rows = (r.top - here.top) * direction;
    if (rows <= 1) continue;
    const column = Math.abs(r.left + r.width / 2 - centre);
    if (rows < bestRow - 1 || (Math.abs(rows - bestRow) <= 1 && column < bestColumn)) {
      best = cell;
      bestRow = rows;
      bestColumn = column;
    }
  }
  return best;
}

/**
 * Search plus every Unicode emoji by category, recent ones first. Keyboard: type to search,
 * arrow keys move between emoji (Down from the search box enters the grid, Up from the first row
 * returns), Enter picks, Esc or a click outside closes.
 */
export default function EmojiPicker({ onPick, onClose }: Props) {
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => getRecentEmoji());
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadEmojiGroups()
      .then((groups) => !cancelled && setStatus({ state: "ready", groups }))
      .catch(() => !cancelled && setStatus({ state: "error" }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Element | null;
      if (rootRef.current?.contains(target) || target?.closest?.(`[${EMOJI_PICKER_TRIGGER_ATTR}]`)) return;
      onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    if (status.state === "ready") for (const g of status.groups) for (const e of g.entries) map.set(e.char, e.label);
    return map;
  }, [status]);

  const results = useMemo(
    () => (status.state === "ready" && query.trim() ? searchEmoji(status.groups, query) : null),
    [status, query]
  );

  function pick(emoji: string) {
    rememberEmoji(emoji);
    setRecent(getRecentEmoji());
    onPick(emoji);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    const cells = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".emoji-cell") ?? []);
    const active = document.activeElement as HTMLElement | null;
    const index = active ? cells.indexOf(active) : -1;

    if (index === -1) {
      // In the search box: Down enters the grid; everything else is ordinary typing.
      if (active === searchRef.current && e.key === "ArrowDown" && cells.length > 0) {
        e.preventDefault();
        cells[0].focus();
      }
      return;
    }

    let next: HTMLElement | null | undefined;
    if (e.key === "ArrowRight") next = cells[index + 1];
    else if (e.key === "ArrowLeft") next = cells[index - 1];
    else if (e.key === "Home") next = cells[0];
    else if (e.key === "End") next = cells[cells.length - 1];
    else if (e.key === "ArrowDown") next = verticalNeighbour(cells, cells[index], 1);
    else if (e.key === "ArrowUp") next = verticalNeighbour(cells, cells[index], -1) ?? searchRef.current;
    else return;

    e.preventDefault();
    if (e.key === "ArrowLeft" && !next) next = searchRef.current;
    next?.focus();
  }

  function cell(emoji: string, label: string) {
    return (
      <button key={emoji} type="button" className="emoji-cell" tabIndex={-1} title={label} aria-label={label} onClick={() => pick(emoji)}>
        {emoji}
      </button>
    );
  }

  return (
    <div ref={rootRef} className="emoji-picker" role="dialog" aria-label="Emoji picker" onKeyDown={handleKeyDown}>
      <input
        {...noAutofill}
        ref={searchRef}
        className="emoji-search"
        type="search"
        placeholder="Search emoji"
        aria-label="Search emoji"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="emoji-scroll">
        {status.state === "loading" && <div className="emoji-note">Loading emoji…</div>}
        {status.state === "error" && (
          <div className="emoji-note">
            Couldn't load the emoji list.{" "}
            <Button
              type="button"
              onClick={() => {
                setStatus({ state: "loading" });
                loadEmojiGroups()
                  .then((groups) => setStatus({ state: "ready", groups }))
                  .catch(() => setStatus({ state: "error" }));
              }}
              variant="link"
            >
              Try again
            </Button>
          </div>
        )}
        {results && (
          <>
            {results.length === 0 && <div className="emoji-note">No emoji match "{query.trim()}".</div>}
            <div className="emoji-picker-grid">{results.map((e) => cell(e.char, e.label))}</div>
          </>
        )}
        {status.state === "ready" && !results && (
          <>
            {recent.length > 0 && (
              <section aria-label="Recently used">
                <h4 className="emoji-heading">Recently used</h4>
                <div className="emoji-picker-grid">{recent.map((e) => cell(e, labels.get(e) ?? e))}</div>
              </section>
            )}
            {status.groups.map((g) => (
              <section key={g.key} aria-label={g.label}>
                <h4 className="emoji-heading">{g.label}</h4>
                <div className="emoji-picker-grid">{g.entries.map((e) => cell(e.char, e.label))}</div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// In rem, like the rest of the UI, so the popover grows with the UI scale; positioning needs real pixels.
const POPOVER_WIDTH_REM = 21.25;
const POPOVER_HEIGHT_REM = 23.75;

/**
 * The picker floating next to a button, clear of the message list's own scrolling and clipping
 * (it is drawn on the page itself, positioned from the button's rectangle when it opened).
 */
export function EmojiPopover({ anchor, onPick, onClose }: Props & { anchor: DOMRect }) {
  const rem = rootFontSize();
  const edge = 0.5 * rem;
  const gap = 0.375 * rem;
  // At a large UI scale in a small window the popover would be wider than the window: shrink it to fit.
  const width = Math.min(POPOVER_WIDTH_REM * rem, window.innerWidth - 2 * edge);
  const height = Math.min(POPOVER_HEIGHT_REM * rem, window.innerHeight - 2 * edge);
  const left = Math.min(Math.max(edge, anchor.right - width), window.innerWidth - width - edge);
  const below = anchor.bottom + gap + height <= window.innerHeight;
  const top = below ? anchor.bottom + gap : Math.max(edge, anchor.top - height - gap);
  return createPortal(
    <div className="emoji-popover" style={{ left, top, width, height }}>
      <EmojiPicker onPick={onPick} onClose={onClose} />
    </div>,
    document.body
  );
}
