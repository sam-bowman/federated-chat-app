import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import { useAppData } from "../context/AppDataContext";
import Modal from "./Modal";

export default function NewConversationModal({ onClose }: { onClose: () => void }) {
  const { friends, refreshConversations } = useAppData();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggle(identity: string) {
    setSelected((prev) => (prev.includes(identity) ? prev.filter((u) => u !== identity) : [...prev, identity]));
  }

  async function handleStart() {
    if (selected.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const type = selected.length === 1 ? "DM" : "GROUP";
      const conversation = await api.createConversation(type, selected);
      await refreshConversations();
      onClose();
      navigate(`/dm/${conversation.id}`);
    } catch {
      setError("Couldn't start conversation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New message" onClose={onClose}>
      {friends.length === 0 ? (
        <p className="hint">Add some friends first.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflowY: "auto" }}>
          {friends.map((f) => (
            <label key={f.id} className="friend-request-row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={selected.includes(f.identity)} onChange={() => toggle(f.identity)} />
              <span className="grow">{f.displayName}</span>
              <span className="hint">{f.identity}</span>
            </label>
          ))}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
      <button className="btn" style={{ marginTop: 12 }} disabled={submitting || selected.length === 0} onClick={handleStart}>
        {selected.length > 1 ? "Start group chat" : "Start conversation"}
      </button>
    </Modal>
  );
}
