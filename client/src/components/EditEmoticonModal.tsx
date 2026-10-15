import { useState } from "react";
import * as api from "../api";
import Modal from "./Modal";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";
import FileButton from "./FileButton";

interface Props {
  emoticon: { id: string; name: string; trigger: string; allowSave: boolean; allowFork: boolean };
  onSaved: () => void;
  onClose: () => void;
}

export default function EditEmoticonModal({ emoticon, onSaved, onClose }: Props) {
  const [name, setName] = useState(emoticon.name);
  const [file, setFile] = useState<File | null>(null);
  const [allowSave, setAllowSave] = useState(emoticon.allowSave);
  const [allowFork, setAllowFork] = useState(emoticon.allowFork);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed =
    name.trim() !== emoticon.name ||
    file !== null ||
    allowSave !== emoticon.allowSave ||
    allowFork !== emoticon.allowFork;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const imageUrl = file ? (await api.uploadFile(file)).url : undefined;
      await api.updateEmoticon(emoticon.id, { name: name.trim(), imageUrl, allowSave, allowFork });
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
        <input {...noAutofill} value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={40} />
        <label className="hint">Replace image (optional)</label>
        <FileButton file={file} onChange={setFile} accept="image/*" />
        <label className="hint">Other people can</label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={allowSave} onChange={(e) => setAllowSave(e.target.checked)} />
          <span>Save it - they use your emoticon, and see your edits straight away</span>
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={allowFork} onChange={(e) => setAllowFork(e.target.checked)} />
          <span>Fork it - they get their own independent copy</span>
        </label>
        <p className="hint">Turning these off only stops new saves and forks; existing ones keep working.</p>
        {error && <div className="error-text">{error}</div>}
        <Button type="submit" disabled={submitting || !name.trim() || !changed}>
          Save changes
        </Button>
      </form>
    </Modal>
  );
}
