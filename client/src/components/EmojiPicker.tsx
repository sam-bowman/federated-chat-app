import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useInRouterContext } from "react-router-dom";
import type { Emoticon } from "../api";
import { loadEmojiGroups, searchEmoji, type EmojiGroup } from "../lib/emojiData";
import { NO_EMOTICONS, allEmoticons, hasEmoticons, searchEmoticons, type EmoticonSets } from "../lib/emoticonSets";
import { noAutofill } from "../lib/noAutofill";
import { rootFontSize } from "../lib/rootFontSize";
import { EMOTICON_RECENT_PREFIX, getRecentEmoji, rememberEmoji } from "../lib/recentEmoji";
import Button from "./Button";
import EmoticonThumb from "./EmoticonThumb";

/** Elements that open the picker mark themselves with this, so their own click isn't treated as "outside". */
export const EMOJI_PICKER_TRIGGER_ATTR = "data-emoji-picker-trigger";

export interface PickOptions {
  /** Shift was held, or the picker is pinned open: the caller should leave it open for the next pick. */
  keepOpen: boolean;
}

interface Props {
  /** Called with the chosen emoji. The picker records it as recent but does not close itself. */
  onPick: (emoji: string, options: PickOptions) => void;
  /** Called with a chosen custom emoticon (only when `emoticons` is given). */
  onPickEmoticon?: (emoticon: Emoticon, options: PickOptions) => void;
  onClose: () => void;
  /**
   * The custom emoticons the person can use, already narrowed to what will render (`renderableSets`).
   * Leave it out for an emoji-only picker.
   */
  emoticons?: EmoticonSets;
  /** The community being viewed, so its emoticons are listed first. */
  communityId?: string | null;
  /** Offer a "keep open" pin, for picking several in a row (inserting into a message). */
  pinnable?: boolean;
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
export default function EmojiPicker({ onPick, onPickEmoticon, onClose, emoticons, communityId, pinnable }: Props) {
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => getRecentEmoji());
  const [pinned, setPinned] = useState(false);
  const inRouter = useInRouterContext();
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

  const searching = query.trim() !== "";
  const sets = emoticons ?? NO_EMOTICONS;
  const byId = useMemo(() => new Map(allEmoticons(sets).map((e) => [e.id, e])), [sets]);
  const emoticonResults = useMemo(() => (query.trim() ? searchEmoticons(allEmoticons(sets), query) : null), [sets, query]);
  const here = communityId ? sets.community.filter((e) => e.communityId === communityId) : [];
  const elsewhere = sets.community.filter((e) => !here.includes(e));
  const emoticonSections: { key: string; label: string; list: Emoticon[] }[] = [
    { key: "mine", label: "Your emoticons", list: sets.personal },
    { key: "saved", label: "Saved", list: sets.saved },
    { key: "here", label: "This community's", list: here },
    { key: "elsewhere", label: here.length > 0 ? "Other communities'" : "Communities", list: elsewhere },
  ].filter((section) => section.list.length > 0);

  function pick(emoji: string, event: React.MouseEvent) {
    rememberEmoji(emoji);
    setRecent(getRecentEmoji());
    onPick(emoji, { keepOpen: pinned || event.shiftKey });
  }

  function pickEmoticon(emoticon: Emoticon, event: React.MouseEvent) {
    rememberEmoji(`${EMOTICON_RECENT_PREFIX}${emoticon.id}`);
    setRecent(getRecentEmoji());
    onPickEmoticon?.(emoticon, { keepOpen: pinned || event.shiftKey });
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
      <button key={emoji} type="button" className="emoji-cell" tabIndex={-1} title={label} aria-label={label} onClick={(e) => pick(emoji, e)}>
        {emoji}
      </button>
    );
  }

  function emoticonCell(emoticon: Emoticon, keyPrefix = "") {
    return (
      <button
        key={`${keyPrefix}${emoticon.id}`}
        type="button"
        className="emoji-cell emoji-cell-image"
        tabIndex={-1}
        title={`${emoticon.name} ${emoticon.trigger}`}
        aria-label={`${emoticon.name} ${emoticon.trigger}`}
        onClick={(e) => pickEmoticon(emoticon, e)}
      >
        <EmoticonThumb emoticon={emoticon} />
      </button>
    );
  }

  // Recently used, newest first: an emoji, or an emoticon that is still one the person can use.
  const recentCells = recent.flatMap((key) => {
    if (!key.startsWith(EMOTICON_RECENT_PREFIX)) return [cell(key, labels.get(key) ?? key)];
    const emoticon = byId.get(key.slice(EMOTICON_RECENT_PREFIX.length));
    return emoticon ? [emoticonCell(emoticon, "recent-")] : [];
  });

  return (
    <div ref={rootRef} className="emoji-picker" role="dialog" aria-label="Emoji picker" onKeyDown={handleKeyDown}>
      <div className="emoji-header">
        <input
          {...noAutofill}
          ref={searchRef}
          className="emoji-search"
          type="search"
          placeholder={emoticons ? "Search emoji and emoticons" : "Search emoji"}
          aria-label={emoticons ? "Search emoji and emoticons" : "Search emoji"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {pinnable && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-pressed={pinned}
            aria-label="Keep open"
            title="Keep open to pick several (or hold Shift)"
            onClick={() => setPinned((p) => !p)}
          >
            {pinned ? "📌 Open" : "📌"}
          </Button>
        )}
      </div>
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
        {searching && (
          <>
            {status.state === "ready" && (results?.length ?? 0) === 0 && (emoticonResults?.length ?? 0) === 0 && (
              <div className="emoji-note">No {emoticons ? "emoji or emoticons" : "emoji"} match "{query.trim()}".</div>
            )}
            <div className="emoji-picker-grid">
              {emoticonResults?.map((e) => emoticonCell(e, "found-"))}
              {results?.map((e) => cell(e.char, e.label))}
            </div>
          </>
        )}
        {/* One fragment with fixed slots, so the emoticon sections keep their elements when the emoji list
            finishes loading (a click that was on its way would otherwise land on a replaced button). */}
        {!searching && (
          <>
            {recentCells.length > 0 && status.state === "ready" ? (
              <section aria-label="Recently used">
                <h4 className="emoji-heading">Recently used</h4>
                <div className="emoji-picker-grid">{recentCells}</div>
              </section>
            ) : null}
            {emoticons && !hasEmoticons(emoticons) ? (
              <div className="emoji-note">
                You have no custom emoticons yet.{" "}
                {inRouter ? <Link to="/emoticons">Make one on the Emoticons page</Link> : "Make one on the Emoticons page"}.
              </div>
            ) : null}
            {emoticonSections.map((section) => (
              <section key={section.key} aria-label={section.label}>
                <h4 className="emoji-heading">{section.label}</h4>
                <div className="emoji-picker-grid">{section.list.map((e) => emoticonCell(e))}</div>
              </section>
            ))}
            {status.state === "ready"
              ? status.groups.map((g) => (
                  <section key={g.key} aria-label={g.label}>
                    <h4 className="emoji-heading">{g.label}</h4>
                    <div className="emoji-picker-grid">{g.entries.map((e) => cell(e.char, e.label))}</div>
                  </section>
                ))
              : null}
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
export function EmojiPopover({ anchor, ...pickerProps }: Props & { anchor: DOMRect }) {
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
      <EmojiPicker {...pickerProps} />
    </div>,
    document.body
  );
}
