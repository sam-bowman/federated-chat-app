import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import { ApiError } from "../api/client";
import { joinByIdFailureMessage, referenceDomain } from "../lib/invite";
import { useFederationEnabled } from "../lib/federation";
import { useAuth } from "../context/AuthContext";
import { domainOf } from "../lib/permissions";
import { useAppData } from "../context/AppDataContext";
import Modal from "./Modal";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";
import Tabs from "./Tabs";

export default function NewCommunityModal({ onClose }: { onClose: () => void }) {
  const { refreshCommunities } = useAppData();
  const navigate = useNavigate();
  const { user } = useAuth();
  const federating = useFederationEnabled();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [joinId, setJoinId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // A private server cannot join a community on another one: say so now rather than after a request that must fail.
    const target = mode === "join" ? referenceDomain(joinId) : null;
    if (!federating && target && user && target.toLowerCase() !== domainOf(user.identity)) {
      setError(joinByIdFailureMessage(403, "federation_disabled", joinId));
      return;
    }
    setSubmitting(true);
    try {
      const community = mode === "create" ? await api.createCommunity(name) : await api.joinCommunity(joinId.trim());
      await refreshCommunities();
      onClose();
      navigate(`/communities/${community.id}`);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setError(mode === "create" ? "Couldn't create community." : joinByIdFailureMessage(status, code, joinId));
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
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
          {mode === "create" ? (
            <input {...noAutofill} placeholder="Community name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          ) : (
            <input {...noAutofill} placeholder="Invite code (shared by a member), for example id:server#code" value={joinId} onChange={(e) => setJoinId(e.target.value)} autoFocus required />
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
