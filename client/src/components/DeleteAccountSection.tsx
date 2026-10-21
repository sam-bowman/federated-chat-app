import { useId, useState } from "react";
import * as api from "../api";
import { ApiError } from "../api/client";
import { useAuth } from "../context/AuthContext";
import Button from "./Button";

interface Scheduled {
  scheduledFor: string;
  graceDays: number;
}

/**
 * Settings -> Delete account (#60). Deleting is the one thing here that cannot be undone, so it asks for everything that proves it is
 * you and that you mean it (your password, your username typed out, a code if you use two-factor sign-in), and it does not erase
 * anything at once: you are signed out and the account is erased after a grace period, in which signing in again cancels it.
 */
export default function DeleteAccountSection() {
  const { user, logout } = useAuth();
  const passwordId = useId();
  const usernameId = useId();
  const codeId = useId();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owned, setOwned] = useState<{ id: string; name: string }[]>([]);
  const [done, setDone] = useState<Scheduled | null>(null);

  if (!user) return null;
  const needsCode = user.totpEnabled === true;
  const matches = typed.trim().toLowerCase() === user.username;
  const ready = password !== "" && matches && (!needsCode || code.trim() !== "");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    setOwned([]);
    try {
      // A recovery code is longer than a code from the app (which is six digits).
      const trimmed = code.trim();
      const input = { password, username: typed, ...(needsCode ? (/^\d{6}$/u.test(trimmed) ? { code: trimmed } : { recoveryCode: trimmed }) : {}) };
      setDone(await api.deleteMyAccount(input));
      setPassword("");
      setCode("");
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { error?: string; communities?: { id: string; name: string }[] } | null) : null;
      if (body?.error === "owns_communities") {
        setOwned(body.communities ?? []);
        setError("You still own a community. Hand it to someone else or delete it first, then try again.");
      } else if (body?.error === "invalid_credentials") setError("That is not your password.");
      else if (body?.error === "invalid_code") setError("That code is not right. Use the one from your authenticator app, or a recovery code.");
      else if (body?.error === "username_mismatch") setError("Type your username exactly as it is shown to confirm.");
      else if (err instanceof ApiError && err.status === 429) setError("Too many tries. Wait a few minutes and try again.");
      else setError("Couldn't ask for the account to be deleted. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const when = new Date(done.scheduledFor).toLocaleString();
    return (
      <>
        <h3>Delete account</h3>
        <p role="status">
          Your account will be erased on <strong>{when}</strong>. You have been signed out everywhere. <strong>Sign in again before then to cancel it.</strong>
        </p>
        <Button type="button" variant="secondary" onClick={logout}>
          Sign out
        </Button>
      </>
    );
  }

  return (
    <>
      <h3>Delete account</h3>
      <p className="hint">
        Erases your account: the messages you wrote (in chats and communities), your friendships and memberships, your emoticons, your
        choices and the files only you used. Other servers are told to forget you. What stays is an anonymous &quot;Deleted user&quot;, and your
        username can never be used again. Download your data first if you want a copy. Backups the server keeps are not changed until
        they expire.
      </p>
      <p className="hint">
        It does not happen at once: you are signed out and the account is erased after a waiting period, and <strong>signing in again before then
        cancels it</strong>. You cannot delete the account while you own a community: hand each one to someone else, or delete it, first.
      </p>
      {!open ? (
        <Button type="button" variant="danger" onClick={() => setOpen(true)}>
          Delete my account…
        </Button>
      ) : (
        <form onSubmit={submit} className="data-export-form">
          <label htmlFor={passwordId}>Your password</label>
          <input id={passwordId} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <label htmlFor={usernameId}>
            Type your username, <strong>{user.username}</strong>, to confirm
          </label>
          <input id={usernameId} type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
          {needsCode && (
            <>
              <label htmlFor={codeId}>Code from your authenticator app (or a recovery code)</label>
              <input id={codeId} type="text" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
            </>
          )}
          <div className="data-export-form-buttons">
            <Button type="submit" variant="danger" busy={busy} disabled={!ready}>
              Delete my account
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <p className="error-text">{error}</p>}
      {owned.length > 0 && (
        <ul>
          {owned.map((c) => (
            <li key={c.id}>{c.name}</li>
          ))}
        </ul>
      )}
    </>
  );
}
