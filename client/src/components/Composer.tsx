import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { Emoticon } from "../api";
import { useWs } from "../context/WsContext";
import { EMOJI_PICKER_TRIGGER_ATTR, EmojiPopover, type PickOptions } from "./EmojiPicker";
import EmoticonThumb from "./EmoticonThumb";
import { completeTrigger, insertAtCursor, suggestEmoticons, triggerBeingTyped } from "../lib/composerText";
import { allEmoticons, renderableSets, type EmoticonSets } from "../lib/emoticonSets";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";

interface Props {
  placeholder: string;
  /** What GET /emoticons returned: the picker and the `:` suggestions offer exactly what will render. */
  emoticons: EmoticonSets;
  /** The community being written in, if any, so the picker lists its emoticons first. */
  communityId?: string | null;
  typingTarget: { conversationId?: string; channelId?: string };
  onSend: (content: string, attachments?: { url: string; filename: string; contentType: string; size: number }[]) => Promise<void>;
}

export default function Composer({ placeholder, emoticons, communityId, typingTarget, onSend }: Props) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingFile, setPendingFile] = useState<{ url: string; filename: string; contentType: string; size: number } | null>(
    null
  );
  const { sendTyping } = useWs();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastTypingSent = useRef(0);
  const listId = useId();

  // Only what will render when sent (a trigger shadowed by a community's emoticon would not).
  const usable = useMemo(() => renderableSets(emoticons), [emoticons]);
  const usableList = useMemo(() => allEmoticons(usable), [usable]);

  // The picker, and where its button was when it opened.
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  // The caret, for the `:` suggestions; and the suggestion list the person dismissed with Esc (until what they
  // are typing changes).
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const match = triggerBeingTyped(value, caret);
  const query = match?.query;
  const suggestions = useMemo(() => (query === undefined ? [] : suggestEmoticons(usableList, query)), [usableList, query]);
  const listOpen = !!match && suggestions.length > 0 && dismissed !== `${match.start}:${match.query}`;
  const activeIndex = Math.min(active, Math.max(suggestions.length - 1, 0));

  // After an edit made here, put the caret where it belongs once React has written the new text into the box
  // (it would otherwise jump to the end).
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    const input = inputRef.current;
    if (pending === null || !input) return;
    pendingCaret.current = null;
    input.setSelectionRange(pending, pending);
    setCaret(pending);
  }, [value]);

  // Closing the picker (Esc, or a pick) leaves focus on nothing: hand it back to the message box. While it stays
  // open for the next pick, focus stays where the person put it.
  useEffect(() => {
    if (pickerAnchor === null && document.activeElement === document.body) inputRef.current?.focus();
  }, [pickerAnchor]);

  function noteTyping() {
    const now = Date.now();
    if (now - lastTypingSent.current > 2000) {
      sendTyping(typingTarget);
      lastTypingSent.current = now;
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setValue(e.target.value);
    setCaret(e.target.selectionStart ?? e.target.value.length);
    setActive(0);
    noteTyping();
  }

  function handleSelect(e: React.SyntheticEvent<HTMLInputElement>) {
    setCaret(e.currentTarget.selectionStart ?? 0);
  }

  function accept(emoticon: Emoticon) {
    if (!match) return;
    const edit = completeTrigger(value, match, emoticon.trigger);
    pendingCaret.current = edit.caret;
    setValue(edit.value);
    setActive(0);
  }

  // Puts an emoji or an emoticon where the caret is (replacing any selection). The message box keeps its own
  // selection while the picker has focus, so several picks in a row land one after another.
  function insert(text: string, isEmoticon: boolean, options: PickOptions) {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    const edit = insertAtCursor(value, start, end, text, isEmoticon);
    pendingCaret.current = edit.caret;
    setValue(edit.value);
    if (!options.keepOpen) setPickerAnchor(null);
    noteTyping();
  }

  // The hidden file <input {...noAutofill}> sitting in the same <form> stops the text input's
  // native implicit-submit-on-Enter from firing, so submit explicitly here.
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (listOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(suggestions[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (match) setDismissed(`${match.start}:${match.query}`);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const uploaded = await api.uploadFile(file);
    setPendingFile(uploaded);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim() && !pendingFile) return;
    setSending(true);
    try {
      await onSend(value.trim() || "(attachment)", pendingFile ? [pendingFile] : undefined);
      setValue("");
      setCaret(0);
      setPendingFile(null);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit} style={{ flexDirection: "column", gap: "0.375rem" }}>
      {pendingFile && (
        <div className="hint">
          📎 {pendingFile.filename}{" "}
          <Button type="button" onClick={() => setPendingFile(null)} variant="secondary" size="sm">
            ✕
          </Button>
        </div>
      )}
      <div style={{ display: "flex", gap: "0.625rem" }}>
        <input type="file" ref={fileInputRef} style={{ display: "none" }} onChange={handleFilePick} />
        <Button type="button" onClick={() => fileInputRef.current?.click()} variant="secondary">
          📎
        </Button>
        <div className="composer-field">
          <input
            {...noAutofill}
            ref={inputRef}
            value={value}
            onChange={handleChange}
            onSelect={handleSelect}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            role="combobox"
            aria-expanded={listOpen}
            aria-controls={listOpen ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={listOpen ? `${listId}-${activeIndex}` : undefined}
          />
          {listOpen && (
            <ul id={listId} className="emoticon-suggestions" role="listbox" aria-label="Emoticon suggestions">
              {suggestions.map((s, i) => (
                <li key={s.id} role="presentation">
                  <button
                    type="button"
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    tabIndex={-1}
                    className={`emoticon-suggestion${i === activeIndex ? " active" : ""}`}
                    // Keep focus (and the caret) in the message box while choosing with the mouse.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => accept(s)}
                  >
                    <EmoticonThumb emoticon={s} />
                    <span>{s.trigger}</span>
                    <span className="hint">{s.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button
          type="button"
          variant="secondary"
          aria-label="Emoji and emoticons"
          aria-haspopup="dialog"
          aria-expanded={pickerAnchor !== null}
          title="Emoji and emoticons"
          {...{ [EMOJI_PICKER_TRIGGER_ATTR]: "" }}
          onClick={(e) => {
            // Read the rectangle now: the event's currentTarget is gone by the time a state updater runs.
            const rect = e.currentTarget.getBoundingClientRect();
            setPickerAnchor((open) => (open ? null : rect));
          }}
        >
          😊
        </Button>
        <Button type="submit" disabled={sending || (!value.trim() && !pendingFile)}>
          Send
        </Button>
      </div>
      {pickerAnchor && (
        <EmojiPopover
          anchor={pickerAnchor}
          emoticons={usable}
          communityId={communityId}
          pinnable
          onPick={(emoji, options) => insert(emoji, false, options)}
          onPickEmoticon={(emoticon, options) => insert(emoticon.trigger, true, options)}
          onClose={() => setPickerAnchor(null)}
        />
      )}
    </form>
  );
}
