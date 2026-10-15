import { useState, type FormEvent } from "react";
import { CUSTOM_STATUS_MAX } from "../lib/presence";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";

interface Props {
  /** The custom status as it is saved now, or null for none. */
  current: string | null;
  /** Saves it; null clears it. Rejects if it could not be saved. */
  onSave: (next: string | null) => Promise<void>;
  /** Called after a successful save (the footer menu closes itself). */
  onSaved?: () => void;
}

/**
 * Setting or clearing the free-text status ("in a meeting"). It starts from what is saved: give it
 * `key={current ?? ""}` so that it starts over whenever the saved value changes elsewhere (the footer
 * menu and Settings both show it), instead of keeping a stale copy of what was saved when it appeared.
 */
export default function CustomStatusForm({ current, onSave, onSaved }: Props) {
  const [draft, setDraft] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const text = draft.trim();
  const canSet = text !== "" && text !== (current ?? "");

  async function save(next: string | null) {
    setBusy(true);
    setFailed(false);
    try {
      await onSave(next);
      onSaved?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    // This form can sit inside another form's React tree; it is its own submit.
    event.preventDefault();
    event.stopPropagation();
    if (canSet && !busy) void save(text);
  }

  return (
    <form onSubmit={submit} className="custom-status-form">
      <div className="custom-status-row">
        <input
          {...noAutofill}
          name="custom-status"
          aria-label="Custom status"
          placeholder="Custom status message…"
          value={draft}
          maxLength={CUSTOM_STATUS_MAX}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" size="sm" busy={busy} disabled={!canSet}>
          Set
        </Button>
        {current !== null && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void save(null)}>
            Clear
          </Button>
        )}
      </div>
      {failed && (
        <div className="error-text" role="alert">
          Couldn't save your status.
        </div>
      )}
    </form>
  );
}
