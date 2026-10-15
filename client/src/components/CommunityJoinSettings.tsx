import { useId, useState } from "react";
import * as api from "../api";
import type { Community } from "../api";
import { useAppData } from "../context/AppDataContext";
import { isOpenToAnyone } from "../lib/invite";

/**
 * Settings -> General -> Joining: whether anyone with the community's id can join, or only people with an invite. Applies at
 * once, like the picture, and is not part of the form below it. Closing it does not remove anyone, and invites (made in the
 * Invite dialog, or sent to friends as cards) keep working: they are the way in once it is closed.
 */
export default function CommunityJoinSettings({ community }: { community: Community }) {
  const { refreshCommunities } = useAppData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const open = isOpenToAnyone(community);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.updateCommunity(community.id, { openJoin: next });
      await refreshCommunities();
    } catch {
      setError("Couldn't change that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="community-join-settings">
      <label className="appearance-check" htmlFor={id}>
        <input id={id} type="checkbox" checked={open} disabled={busy} onChange={(e) => void change(e.target.checked)} />
        Anyone with the community code can join
      </label>
      <div className="hint">
        {open
          ? "Turn this off to make the community invite-only: people then need an invite from a member. People already in stay."
          : "This community is invite-only. People need an invite from a member; the community code no longer lets anyone in."}
      </div>
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
