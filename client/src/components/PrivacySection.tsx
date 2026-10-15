import { useState } from "react";
import * as api from "../api";
import { ApiError } from "../api/client";
import { useAuth } from "../context/AuthContext";

/**
 * Settings -> Privacy: whether people on other servers can find you by your handle. Off, a server that has nothing to do with you
 * (no friend, request, conversation or community in common with anyone on it) is told you do not exist, so it cannot look you
 * up, send you a friend request or start a conversation with you. Anything you already have with a server carries on. People on
 * your own server are not affected.
 *
 * The server can take the choice away (it then says so here and the switch is off and disabled), and a server that predates
 * this setting sends neither field, in which case nothing is shown, since there is nothing to change.
 */
export default function PrivacySection() {
  const { user, refreshUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user || user.discoverable === undefined) return null;

  const locked = user.discoverabilityLocked === true;
  const findable = locked ? false : user.discoverable;

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.updateMe({ discoverable: next });
      await refreshUser();
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setError(code === "discoverability_locked" ? "This server has turned this off for everyone." : "Couldn't save that. Try again.");
      await refreshUser().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Privacy</h3>
      <label className="appearance-check">
        <input type="checkbox" checked={findable} disabled={busy || locked} onChange={(e) => void change(e.target.checked)} />
        Let people on other servers find me
      </label>
      <p className="hint" style={{ marginTop: "0.25rem" }}>
        {locked
          ? "This server has turned this off for everyone: people on servers you have nothing to do with can't find you, whatever you choose here."
          : findable
            ? "Anyone on another server can look you up by your username, send you a friend request or start a conversation."
            : "A server you have nothing to do with is told you don't exist: it can't look you up, send you a friend request or start a conversation. What you already have with a server carries on, and people on your own server can still find you."}
      </p>
      {error && <div className="error-text">{error}</div>}
    </>
  );
}
