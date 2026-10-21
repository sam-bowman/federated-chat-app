import { useId, useState } from "react";
import * as api from "../api";
import { ApiError } from "../api/client";
import Button from "./Button";

/** Saves a downloaded file the way a link with a `download` attribute does, then lets go of it. */
function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Settings -> Your data: a copy of everything this server holds about you, as one file you can keep. It asks for your password
 * again, so someone holding your open session cannot take your history. It has your account, who you know, your communities and
 * chats, what YOU wrote (not other people's messages) and your choices; no passwords or tokens. Attached files are listed by
 * address, not included.
 */
export default function DataExportSection() {
  const passwordId = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function download(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const { blob, filename } = await api.exportMyData(password);
      const name = filename ?? "chat-export.json";
      saveFile(blob, name);
      setSaved(name);
      setPassword("");
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setError(
        code === "invalid_credentials"
          ? "That is not your password."
          : err instanceof ApiError && err.status === 429
            ? "Too many tries. Wait a few minutes and try again."
            : "Couldn't get your data. Try again."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Your data</h3>
      <p className="hint">
        Download a copy of what this server holds about you: your account, who you know, your communities and chats, the messages you
        wrote (not other people's), the emoticons you made and your choices. No passwords or tokens. Files you attached are listed by
        address, not included.
      </p>
      <form onSubmit={download} className="data-export-form">
        <label htmlFor={passwordId}>Your password</label>
        <input id={passwordId} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="secondary" busy={busy} disabled={!password}>
          Download my data
        </Button>
      </form>
      {error && <p className="error-text">{error}</p>}
      {saved && (
        <p className="hint" role="status">
          Saved {saved}.
        </p>
      )}
    </>
  );
}
