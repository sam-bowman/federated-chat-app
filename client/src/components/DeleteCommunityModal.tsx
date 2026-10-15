import { useState } from "react";
import * as api from "../api";
import type { Community } from "../api";
import { ApiError } from "../api/client";
import { useAppData } from "../context/AppDataContext";
import { noAutofill } from "../lib/noAutofill";
import Modal from "./Modal";
import Button from "./Button";

interface Props {
  community: Community;
  onClose: () => void;
  /** Called once it is gone, so the settings that led here can close. */
  onDeleted: () => void;
}

/**
 * Deleting is permanent and takes every channel, message and role with it, so the button stays disabled
 * until the community's exact name has been typed.
 */
export default function DeleteCommunityModal({ community, onClose, onDeleted }: Props) {
  const { refreshCommunities } = useAppData();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = typed === community.name;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteCommunity(community.id);
      await refreshCommunities();
      onDeleted();
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setError(code === "forbidden" ? "Only the owner can delete a community." : "Couldn't delete the community. Try again.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Delete community" onClose={onClose} width={440}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="hint">
          This permanently deletes <strong>{community.name}</strong>: all {community.channels.length}{" "}
          {community.channels.length === 1 ? "channel" : "channels"}, every message in them, its roles, and the
          community itself for all {community.members.length} {community.members.length === 1 ? "member" : "members"}. It
          cannot be undone. To keep it going without you, transfer ownership instead.
        </p>
        <label className="hint" htmlFor="delete-community-name">
          Type the community's name to confirm
        </label>
        <input
          {...noAutofill}
          id="delete-community-name"
          placeholder={community.name}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
        />
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <Button type="button" onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button type="submit" disabled={!matches || busy} variant="danger">
            {busy ? "Deleting…" : "Delete community"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
