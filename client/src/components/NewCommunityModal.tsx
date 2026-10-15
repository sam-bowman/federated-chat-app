import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import { useAppData } from "../context/AppDataContext";
import Modal from "./Modal";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";

export default function NewCommunityModal({ onClose }: { onClose: () => void }) {
  const { refreshCommunities } = useAppData();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [joinId, setJoinId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const community = mode === "create" ? await api.createCommunity(name) : await api.joinCommunity(joinId.trim());
      await refreshCommunities();
      onClose();
      navigate(`/communities/${community.id}`);
    } catch {
      setError(mode === "create" ? "Couldn't create community." : "Couldn't find or join that community.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={mode === "create" ? "Create a community" : "Join a community"} onClose={onClose}>
      <div className="tabs" role="tablist" style={{ padding: 0, marginBottom: 10 }}>
        <button type="button" role="tab" aria-selected={mode === "create"} className={`tab ${mode === "create" ? "active" : ""}`} onClick={() => setMode("create")}>
          Create new
        </button>
        <button type="button" role="tab" aria-selected={mode === "join"} className={`tab ${mode === "join" ? "active" : ""}`} onClick={() => setMode("join")}>
          Join by ID
        </button>
      </div>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {mode === "create" ? (
          <input {...noAutofill} placeholder="Community name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        ) : (
          <input {...noAutofill} placeholder="Community ID (shared by a member)" value={joinId} onChange={(e) => setJoinId(e.target.value)} autoFocus required />
        )}
        {error && <div className="error-text">{error}</div>}
        <Button type="submit" disabled={submitting || (mode === "create" ? !name.trim() : !joinId.trim())}>
          {mode === "create" ? "Create" : "Join"}
        </Button>
      </form>
    </Modal>
  );
}
