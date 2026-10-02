import { useState } from "react";
import * as api from "../api";
import { mediaUrl } from "../api";
import { ApiError } from "../api/client";
import Modal from "./Modal";

interface Props {
  emoticon: { id: string; name: string; trigger: string; imageUrl: string };
  onSaved: () => void;
  onClose: () => void;
}

export default function SaveEmoticonModal({ emoticon, onSaved, onClose }: Props) {
  const [trigger, setTrigger] = useState(emoticon.trigger);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const normalized = trigger.startsWith(":") ? trigger : `:${trigger}`;
    const finalTrigger = normalized.endsWith(":") ? normalized : `${normalized}:`;
    setSubmitting(true);
    setError(null);
    try {
      await api.saveEmoticon(emoticon.id, finalTrigger === emoticon.trigger ? undefined : finalTrigger);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && (err.body as any)?.error === "trigger_already_in_use") {
        setError("You already have an emoticon using that trigger - pick another.");
      } else {
        setError("Couldn't save that trigger. Check the format (e.g. :frog:).");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Save emoticon" onClose={onClose}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
        <div className="emoji-tile" style={{ width: 56, height: 56 }}>
          <img src={mediaUrl(emoticon.imageUrl)} alt={emoticon.name} />
        </div>
        <div>
          <div style={{ fontWeight: 600 }}>{emoticon.name}</div>
          <div className="hint">Original trigger: {emoticon.trigger}</div>
        </div>
      </div>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="hint">Trigger to use in your own messages</label>
        <input value={trigger} onChange={(e) => setTrigger(e.target.value.toLowerCase())} autoFocus required />
        {error && <div className="error-text">{error}</div>}
        <button className="btn" type="submit" disabled={submitting || !trigger.trim()}>
          Save to my emoticons
        </button>
      </form>
    </Modal>
  );
}
