import type { Emoticon } from "../api";
import { searchEmoticons } from "./emoticonSets";

export interface TextEdit {
  value: string;
  /** Where the caret goes: just after what was inserted. */
  caret: number;
}

/**
 * Puts `text` where the caret is, replacing any selection. An emoticon trigger (`pad`) gets a space
 * on each side unless there is already whitespace there (or the start/end of the text), so two in a
 * row do not run together; a Unicode emoji goes in exactly as it is. The caret ends up after the
 * insertion and the space that follows it, ready to keep typing.
 */
export function insertAtCursor(value: string, start: number, end: number, text: string, pad: boolean): TextEdit {
  const from = Math.max(0, Math.min(start, end, value.length));
  const to = Math.min(value.length, Math.max(start, end));
  const before = value.slice(0, from);
  const after = value.slice(to);
  const lead = pad && before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = pad && !/^\s/.test(after) ? " " : "";
  const inserted = `${lead}${text}${trail}`;
  // A space that was already there after it is the one that separates it from what follows: step over it.
  const skip = pad && trail === "" && after !== "" ? 1 : 0;
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length + skip };
}

export interface TriggerMatch {
  /** Index of the opening colon. */
  start: number;
  /** The caret, where the typed part ends. */
  end: number;
  /** What was typed after the colon, lower-cased. */
  query: string;
}

/** Typing ":" plus at least this many characters starts the suggestions. */
export const AUTOCOMPLETE_MIN_CHARS = 2;

/**
 * The `:partial` word being typed just before the caret, or null. The colon must start a word (after
 * whitespace or at the start), so a time like "10:30" or a URL never opens the list, and a trigger that
 * is already closed (":party:") is finished, not being typed.
 */
export function triggerBeingTyped(value: string, caret: number): TriggerMatch | null {
  const upto = value.slice(0, caret);
  const match = /(^|\s):([a-zA-Z0-9_]*)$/.exec(upto);
  if (!match || match[2].length < AUTOCOMPLETE_MIN_CHARS) return null;
  const start = upto.length - match[2].length - 1;
  return { start, end: caret, query: match[2].toLowerCase() };
}

export const MAX_SUGGESTIONS = 8;

export function suggestEmoticons(list: Emoticon[], query: string): Emoticon[] {
  return searchEmoticons(list, query).slice(0, MAX_SUGGESTIONS);
}

/** Replaces the half-typed `:par` with the chosen trigger (and a space), caret after it. */
export function completeTrigger(value: string, match: TriggerMatch, trigger: string): TextEdit {
  return insertAtCursor(value, match.start, match.end, trigger, true);
}
