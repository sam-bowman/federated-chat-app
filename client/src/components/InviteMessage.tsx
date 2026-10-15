import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { InviteCard } from "../api";
import * as api from "../api";
import { ApiError } from "../api/client";
import { useAppData } from "../context/AppDataContext";
import { inviteCardCode, joinFailureMessage } from "../lib/invite";
import Button from "./Button";

interface Props {
  invite: InviteCard;
  /** Who sent it, for "<name> invited you to join". */
  senderName: string;
  /** Whether the person looking sent it: they see what they sent, not a button to join. */
  isOwn: boolean;
}

/**
 * A community invitation in a conversation: the community, who invited you, and a Join button that
 * joins without a code. Once you are in it says so and offers to open it; if joining fails (you
 * were banned since, the community is gone, its server is unreachable) it says why, since a card
 * can be old.
 *
 * Everything on it is user data (the name was typed by whoever made the community), so it is
 * rendered as text and nothing else.
 */
export default function InviteMessage({ invite, senderName, isOwn }: Props) {
  const { communities, refreshCommunities } = useAppData();
  const navigate = useNavigate();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joined = communities.some((c) => c.id === invite.communityId);

  async function join() {
    setJoining(true);
    setError(null);
    try {
      await api.joinCommunity(inviteCardCode(invite));
      await refreshCommunities();
      navigate(`/communities/${invite.communityId}`);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setError(joinFailureMessage(status, code, invite.domain));
      setJoining(false);
    }
  }

  return (
    <div className="invite-card">
      <div className="invite-card-icon" aria-hidden="true">
        {invite.name.trim().charAt(0).toUpperCase() || "?"}
      </div>
      <div className="invite-card-body">
        <div className="hint">{isOwn ? "You invited them to join" : `${senderName} invited you to join`}</div>
        <div className="invite-card-name">{invite.name}</div>
        <div className="hint">{invite.domain}</div>
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
      </div>
      {!isOwn &&
        (joined ? (
          <div className="invite-card-actions">
            <span className="hint">Joined</span>
            <Button variant="secondary" size="sm" onClick={() => navigate(`/communities/${invite.communityId}`)}>
              Open
            </Button>
          </div>
        ) : (
          <Button size="sm" busy={joining} onClick={() => void join()}>
            Join
          </Button>
        ))}
    </div>
  );
}
