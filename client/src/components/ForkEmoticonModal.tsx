import { useState } from "react";
import * as api from "../api";
import { mediaUrl } from "../api";
import { ApiError } from "../api/client";
import Modal from "./Modal";
import { noAutofill } from "../lib/noAutofill";

interface Props {
  emoticon: { id: string; name: string; trigger: string; imageUrl: string };
  onForked: () => void;
  onClose: () => void;
}

export default function ForkEmoticonModal({ emoticon, onForked, onClose }: Props) {
  const [name, setName] = useState(emoticon.name);
  const [trigger, setTrigger] = useState(emoticon.trigger);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const normalized = trigger.startsWith(":") ? trigger : `:${trigger}`;
    const finalTrigger = normalized.endsWith(":") ? normalized : `${normalized}:`;
    setSubmitting(true);
    setError(null);
    try {
      const imageUrl = file ? (await api.uploadFile(file)).url : undefined;
      await api.forkEmoticon(emoticon.id, { name, trigger: finalTrigger, imageUrl });
      onForked();
      onClose();
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      if (code === "trigger_already_in_use") {
        setError("You already have an emoticon using that trigger - pick another.");
      } else if (code === "forking_not_allowed") {
        setError("The creator has turned off forking for this emoticon.");
      } else {
        setError("Couldn't fork that emoticon. Check the trigger format (e.g. :frog:).");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Fork emoticon" onClose={onClose}>
      <p className="hint" style={{ marginBottom: 12 }}>
        Makes your own independent copy. It won't change when the original does - unless you choose to sync it later.
      </p>
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
        <label className="hint">Name</label>
        <input {...noAutofill} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        <label className="hint">Trigger to use in your own messages</label>
        <input {...noAutofill} value={trigger} onChange={(e) => setTrigger(e.target.value.toLowerCase())} required />
        <label className="hint">Image (optional - leave empty to start from a copy of the original's)</label>
        <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {error && <div className="error-text">{error}</div>}
        <button className="btn" type="submit" disabled={submitting || !name.trim() || !trigger.trim()}>
          Fork to my emoticons
        </button>
      </form>
    </Modal>
  );
}
