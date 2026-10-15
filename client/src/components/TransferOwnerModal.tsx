import { useState } from "react";
import * as api from "../api";
import type { Community, CommunityMember } from "../api";
import { ApiError } from "../api/client";
import { useAppData } from "../context/AppDataContext";
import { noAutofill } from "../lib/noAutofill";
import { domainOf } from "../lib/permissions";
import Avatar from "./Avatar";
import Modal from "./Modal";
import Button from "./Button";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err.body as { error?: string } | null)?.error;
    if (code === "invalid_credentials") return "That password isn't right.";
    if (code === "not_a_member") return "They are no longer a member of this community.";
    if (code === "new_owner_must_be_local") return "Only someone with an account on this server can own a community.";
    if (code === "ownership_changed") return "Ownership changed while you were doing this. Close this and look again.";
    if (code === "forbidden") return "Only the owner can transfer a community.";
    if (err.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  }
  return "Couldn't transfer ownership. Try again.";
}

interface Props {
  community: Community;
  viewer: { id: string; identity: string };
  onClose: () => void;
  /** Called once ownership has moved, so the settings that led here can close. */
  onTransferred: () => void;
}

/**
 * Hand the community to another member. Only people on this server can be chosen (a community owned from
 * another server could not be managed by anyone), the owner confirms with their password because they
 * cannot undo it, and the dialog says plainly what they give up.
 */
export default function TransferOwnerModal({ community, viewer, onClose, onTransferred }: Props) {
  const { refreshCommunities } = useAppData();
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<CommunityMember | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = community.members.filter(
    (m) => m.id !== community.owner.id && domainOf(m.identity) === domainOf(viewer.identity)
  );
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? candidates.filter((m) => `${m.displayName} ${m.identity}`.toLowerCase().includes(needle))
    : candidates;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await api.transferCommunityOwner(community.id, chosen.id, password);
      await refreshCommunities();
      onTransferred();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (candidates.length === 0) {
    // Nothing to choose from, so no form: just why, and a way out. The two causes read differently.
    const others = community.members.filter((m) => m.id !== community.owner.id);
    return (
      <Modal title="Transfer ownership" onClose={onClose} width={440}>
        <p className="hint">
          {others.length === 0
            ? `Nobody else is in ${community.name} yet, so there is no one to hand it to.`
            : `Everyone else in ${community.name} is on another server, and only someone with an account on this server can own a community (nobody could manage one owned from another server).`}{" "}
          Get someone from this server to join first: the Invite button in the community header lets you invite a friend or
          share a code.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button type="button" onClick={onClose} variant="secondary">
            Close
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Transfer ownership" onClose={onClose} width={440}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="hint" htmlFor="transfer-filter">
          New owner
        </label>
        <input
          {...noAutofill}
          id="transfer-filter"
          type="search"
          placeholder="Search members"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
        <div role="radiogroup" aria-label="New owner" style={{ maxHeight: 180, overflowY: "auto" }}>
          {shown.length === 0 && <div className="empty-state">No member matches.</div>}
          {shown.map((m) => (
            <label key={m.id} className="friend-request-row" style={{ cursor: "pointer", marginBottom: 4 }}>
              <input
                type="radio"
                name="new-owner"
                checked={chosen?.id === m.id}
                onChange={() => setChosen(m)}
              />
              <Avatar user={m} size="sm" />
              <div className="grow">
                <div>{m.displayName}</div>
                <div className="hint">{m.identity}</div>
              </div>
            </label>
          ))}
        </div>

        {chosen && (
          <p className="hint">
            {chosen.displayName} will own {community.name}, with every permission. You become an ordinary member and
            lose the ability to manage it - only {chosen.displayName} can give any of that back.
          </p>
        )}

        <label className="hint" htmlFor="transfer-password">
          Confirm with your password
        </label>
        <input
          id="transfer-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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
          <Button type="submit" disabled={busy || !chosen || !password} variant="danger">
            {busy ? "Transferring…" : "Transfer ownership"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
