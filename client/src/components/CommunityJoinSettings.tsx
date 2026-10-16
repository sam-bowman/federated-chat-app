import { useId, useState } from "react";
import * as api from "../api";
import type { Community } from "../api";
import { useAppData } from "../context/AppDataContext";
import { VISIBILITY_CHOICES, visibilityOf, type CommunityVisibility } from "../lib/communityVisibility";

/**
 * Settings -> General -> Joining: who can join. Anyone with the community code, only people with an invite, or only people on
 * this server. Applies at once, like the picture, and is not part of the form below it. Changing it removes nobody, and invites
 * (made in the Invite dialog, or sent to friends as cards) keep working under the first two. The choice shows as soon as it is
 * made and goes back if saving fails.
 */
export default function CommunityJoinSettings({
  community,
  directoryPublished = true,
}: {
  community: Community;
  /** Whether the server publishes a directory (a server that predates it does not say, which is treated as yes: nothing to warn about). */
  directoryPublished?: boolean;
}) {
  const { refreshCommunities } = useAppData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<CommunityVisibility | null>(null);
  const name = useId();
  const current = chosen ?? visibilityOf(community);

  async function change(next: CommunityVisibility) {
    setBusy(true);
    setError(null);
    setChosen(next);
    try {
      await api.updateCommunity(community.id, { visibility: next });
      await refreshCommunities();
    } catch {
      setError("Couldn't change that. Try again.");
    } finally {
      setChosen(null);
      setBusy(false);
    }
  }

  return (
    <fieldset className="community-join-settings radio-fieldset" disabled={busy}>
      <legend>Who can join</legend>
      {VISIBILITY_CHOICES.map((choice) => (
        <label key={choice.value} className="appearance-check">
          <input type="radio" name={name} value={choice.value} checked={current === choice.value} onChange={() => void change(choice.value)} />
          <span>
            {choice.label}
            <span className="hint" style={{ display: "block" }}>
              {choice.description}
            </span>
          </span>
        </label>
      ))}
      {current === "PUBLIC" && !directoryPublished && (
        <div className="hint" role="note">
          This server doesn't publish a directory, so for now this works like "Anyone with the community code". It is listed if the server
          starts to.
        </div>
      )}
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
    </fieldset>
  );
}
