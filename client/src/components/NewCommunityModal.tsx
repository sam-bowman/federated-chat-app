import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import { useAppData } from "../context/AppDataContext";
import Modal from "./Modal";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";
import Tabs from "./Tabs";

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
      <Tabs
        label="Create or join a community"
        value={mode}
        onChange={setMode}
        minHeight="7rem"
        tabs={[
          { id: "create", label: "Create new" },
          { id: "join", label: "Join by ID" },
        ]}
      >
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {mode === "create" ? (
            <input {...noAutofill} placeholder="Community name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          ) : (
            <input {...noAutofill} placeholder="Invite code (shared by a member)" value={joinId} onChange={(e) => setJoinId(e.target.value)} autoFocus required />
          )}
          {error && <div className="error-text">{error}</div>}
          <Button type="submit" disabled={submitting || (mode === "create" ? !name.trim() : !joinId.trim())}>
            {mode === "create" ? "Create" : "Join"}
          </Button>
        </form>
      </Tabs>
    </Modal>
  );
}
