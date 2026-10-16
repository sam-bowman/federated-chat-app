import { useState } from "react";
import * as api from "../api";
import { ApiError } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { CONTACT_CHOICES, type ContactPolicy } from "../lib/contact";

/**
 * Settings -> Privacy: two choices about people on other servers (and, for the second, on this one).
 *
 * "Let people on other servers find me": off, a server that has nothing to do with you (no friend, request, conversation or
 * community in common with anyone on it) is told you do not exist, so it cannot look you up, send you a friend request or start a
 * conversation with you. What you already have with a server carries on, and people on your own server are not affected. The server
 * can take this choice away (it then says so and the switch is off and disabled).
 *
 * "Who can send me friend requests and start conversations": anyone, only people you share a community with, or only people on
 * your own server. Friends are always let in and nothing you already have is touched.
 *
 * "List me in the directory of people": the server's directory (if it publishes one) lists people who chose to be, for anyone to browse and
 * add. It only counts while you can be found by other servers (hiding wins), and it is off until you choose.
 *
 * A server that predates a setting sends no field for it, in which case that part is not shown, since there is nothing to change.
 */
export default function PrivacySection() {
  const { user, refreshUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The choice just made, shown at once while it is being saved (the radio would otherwise only move after the server answers, and a
  // click would look as if it had done nothing); dropped when the save is over, for the saved value to show, or the old one if it failed.
  const [chosen, setChosen] = useState<ContactPolicy | null>(null);
  if (!user || (user.discoverable === undefined && user.contactPolicy === undefined && user.listedInDirectory === undefined)) return null;

  const locked = user.discoverabilityLocked === true;
  const findable = locked ? false : user.discoverable === true;

  async function change(patch: { discoverable?: boolean; contactPolicy?: ContactPolicy; listedInDirectory?: boolean }) {
    setBusy(true);
    setError(null);
    setChosen(patch.contactPolicy ?? null);
    try {
      await api.updateMe(patch);
      await refreshUser();
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setError(code === "discoverability_locked" ? "This server has turned this off for everyone." : "Couldn't save that. Try again.");
      await refreshUser().catch(() => {});
    } finally {
      setChosen(null);
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Privacy</h3>
      {user.discoverable !== undefined && (
        <>
          <label className="appearance-check">
            <input type="checkbox" checked={findable} disabled={busy || locked} onChange={(e) => void change({ discoverable: e.target.checked })} />
            Let people on other servers find me
          </label>
          <p className="hint" style={{ marginTop: "0.25rem" }}>
            {locked
              ? "This server has turned this off for everyone: people on servers you have nothing to do with can't find you, whatever you choose here."
              : findable
                ? "Anyone on another server can look you up by your username."
                : "A server you have nothing to do with is told you don't exist: it can't look you up, send you a friend request or start a conversation. What you already have with a server carries on, and people on your own server can still find you."}
          </p>
        </>
      )}

      {user.contactPolicy !== undefined && (
        <fieldset className="radio-fieldset" disabled={busy}>
          <legend>Who can send me friend requests and start conversations</legend>
          {CONTACT_CHOICES.map((choice) => (
            <label key={choice.value} className="appearance-check">
              <input
                type="radio"
                name="contact-policy"
                value={choice.value}
                checked={(chosen ?? user.contactPolicy) === choice.value}
                onChange={() => void change({ contactPolicy: choice.value })}
              />
              <span>
                {choice.label}
                <span className="hint" style={{ display: "block" }}>
                  {choice.description}
                </span>
              </span>
            </label>
          ))}
          <p className="hint">Your friends can always write to you, and conversations you already have are not affected.</p>
        </fieldset>
      )}

      {user.listedInDirectory !== undefined && (
        <>
          <label className="appearance-check" style={{ marginTop: "1rem" }}>
            <input
              type="checkbox"
              checked={user.listedInDirectory}
              disabled={busy || locked}
              onChange={(e) => void change({ listedInDirectory: e.target.checked })}
            />
            List me in this server's directory of people
          </label>
          <p className="hint" style={{ marginTop: "0.25rem" }}>
            {locked
              ? "This server has turned this off for everyone, so nobody is listed."
              : user.directoryEnabled === false
                ? "This server doesn't publish a directory, so you won't be listed anywhere yet. Your choice is kept for if it does."
                : user.discoverable === false
                  ? "You're not listed while other servers can't find you: turn that on above to be listed."
                  : user.listedInDirectory
                    ? "People browsing the directory, on this server or another, can see your name, picture and bio and send you a friend request."
                    : "Off: you aren't listed. Turn it on and people browsing the directory, on this server or another, can see your name, picture and bio and send you a friend request."}
          </p>
        </>
      )}
      {error && <div className="error-text">{error}</div>}
    </>
  );
}
