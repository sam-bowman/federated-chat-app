import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import { useAppData } from "../context/AppDataContext";
import Modal from "./Modal";

export default function NewChannelModal({ communityId, onClose }: { communityId: string; onClose: () => void }) {
  const { refreshCommunities } = useAppData();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const channel = await api.createChannel(communityId, name, topic || undefined);
      await refreshCommunities();
      onClose();
      navigate(`/communities/${communityId}/${channel.id}`);
    } catch {
      setError("Couldn't create channel.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create a channel" onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input placeholder="channel-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        <input placeholder="Topic (optional)" value={topic} onChange={(e) => setTopic(e.target.value)} />
        {error && <div className="error-text">{error}</div>}
        <button className="btn" type="submit" disabled={submitting || !name.trim()}>
          Create
        </button>
      </form>
    </Modal>
  );
}
