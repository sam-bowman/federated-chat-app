import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import { useAppData } from "../context/AppDataContext";
import Modal from "./Modal";
import Button from "./Button";
import { useAuth } from "../context/AuthContext";
import { contactRefusalMessage, isContactRefusal } from "../lib/contact";
import { federationRefusalMessage, isOnAnotherServer, useFederationEnabled } from "../lib/federation";
import { ApiError } from "../api/client";

export default function NewConversationModal({ onClose }: { onClose: () => void }) {
  const { friends, refreshConversations } = useAppData();
  const navigate = useNavigate();
  const { user } = useAuth();
  const federating = useFederationEnabled();
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
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setError(isContactRefusal(code) ? contactRefusalMessage("conversation") : (federationRefusalMessage(code) ?? "Couldn't start conversation."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New message" onClose={onClose}>
      {friends.length === 0 ? (
        <p className="hint">Add some friends first.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem", maxHeight: "18.75rem", overflowY: "auto" }}>
          {friends.map((f) => {
            // A private server cannot start a conversation with someone on another one (an existing one is still there to read).
            const unreachable = !federating && !!user && isOnAnotherServer(f.identity, user.identity);
            return (
              <label key={f.id} className="friend-request-row" style={{ cursor: unreachable ? "default" : "pointer" }}>
                <input type="checkbox" checked={selected.includes(f.identity)} disabled={unreachable} onChange={() => toggle(f.identity)} />
                <span className="grow">{f.displayName}</span>
                <span className="hint">{unreachable ? `${f.identity} (another server)` : f.identity}</span>
              </label>
            );
          })}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
      <Button disabled={submitting || selected.length === 0} onClick={handleStart} style={{ marginTop: "0.75rem" }}>
        {selected.length > 1 ? "Start group chat" : "Start conversation"}
      </Button>
    </Modal>
  );
}
