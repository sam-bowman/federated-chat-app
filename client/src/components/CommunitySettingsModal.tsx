import { useState } from "react";
import * as api from "../api";
import type { Community } from "../api";
import { useAppData } from "../context/AppDataContext";
import Modal from "./Modal";

export default function CommunitySettingsModal({ community, onClose }: { community: Community; onClose: () => void }) {
  const { refreshCommunities } = useAppData();
  const [name, setName] = useState(community.name);
  const [description, setDescription] = useState(community.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.updateCommunity(community.id, { name, description: description || null });
      await refreshCommunities();
      onClose();
    } catch {
      setError("Couldn't save changes.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Community settings" onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="hint">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        <label className="hint">Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        {error && <div className="error-text">{error}</div>}
        <button className="btn" type="submit" disabled={submitting || !name.trim()}>
          Save
        </button>
      </form>
    </Modal>
  );
}
