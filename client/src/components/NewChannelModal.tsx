import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import { ApiError, getHomeServer } from "../api/client";
import { fetchServerInfo } from "../api/discovery";
import { useAppData } from "../context/AppDataContext";
import Modal from "./Modal";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";

export default function NewChannelModal({ communityId, onClose }: { communityId: string; onClose: () => void }) {
  const { refreshCommunities } = useAppData();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [type, setType] = useState<"TEXT" | "VOICE">("TEXT");
  // Offered only on a server that has voice: asked of its discovery document when the dialog opens.
  const [voiceOffered, setVoiceOffered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const origin = getHomeServer()?.origin;
    if (!origin) return;
    let current = true;
    fetchServerInfo(origin)
      .then((info) => current && setVoiceOffered(info.voiceEnabled === true))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const channel = await api.createChannel(communityId, name, topic || undefined, type === "VOICE" ? "VOICE" : undefined);
      await refreshCommunities();
      onClose();
      // A voice channel has no page of its own: it is joined from the sidebar.
      if (type === "TEXT") navigate(`/communities/${communityId}/${channel.id}`);
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setError(code === "voice_not_enabled" ? "Voice isn't set up on this server." : "Couldn't create channel.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create a channel" onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
        {voiceOffered && (
          <div role="radiogroup" aria-label="Channel type" className="channel-type">
            <label>
              <input type="radio" name="channel-type" checked={type === "TEXT"} onChange={() => setType("TEXT")} /> Text
            </label>
            <label>
              <input type="radio" name="channel-type" checked={type === "VOICE"} onChange={() => setType("VOICE")} /> Voice
            </label>
          </div>
        )}
        <input {...noAutofill} placeholder="channel-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        <input {...noAutofill} placeholder="Topic (optional)" value={topic} onChange={(e) => setTopic(e.target.value)} />
        {error && <div className="error-text">{error}</div>}
        <Button type="submit" disabled={submitting || !name.trim()}>
          Create
        </Button>
      </form>
    </Modal>
  );
}
