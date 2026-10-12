import { useState } from "react";
import * as api from "../api";
import Modal from "./Modal";

interface Props {
  emoticon: { id: string; name: string; trigger: string };
  onSaved: () => void;
  onClose: () => void;
}

export default function EditEmoticonModal({ emoticon, onSaved, onClose }: Props) {
  const [name, setName] = useState(emoticon.name);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = name.trim() !== emoticon.name || file !== null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const imageUrl = file ? (await api.uploadFile(file)).url : undefined;
      await api.updateEmoticon(emoticon.id, { name: name.trim(), imageUrl });
      onSaved();
      onClose();
    } catch {
      setError("Couldn't save your changes. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Edit emoticon" onClose={onClose}>
      <p className="hint" style={{ marginBottom: 12 }}>
        Editing <strong>{emoticon.trigger}</strong>. People who saved it see the change straight away; forks of it keep
        their current image until their owners sync. The trigger can't be changed.
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="hint">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={40} />
        <label className="hint">Replace image (optional)</label>
        <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {error && <div className="error-text">{error}</div>}
        <button className="btn" type="submit" disabled={submitting || !name.trim() || !changed}>
          Save changes
        </button>
      </form>
    </Modal>
  );
}
