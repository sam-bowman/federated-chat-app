import { createContext, useCallback, useContext, useId, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../../api";
import { adminErrorMessage, isSudoRequired } from "../../lib/adminText";
import Button from "../Button";
import Modal from "../Modal";

// "Sudo mode" on the admin page (#206): anything that changes something needs a recent proof that the person at the keyboard is the admin, so
// a stolen session cannot do it. `run` takes what to do with a sudo token: it asks for the password and a code once (and again when ten minutes
// have passed, or the server says the token is no longer good), then does it. The token is kept in memory only, never stored anywhere.

/** The admin closed the confirmation without confirming. Not an error to show: they chose not to. */
export class SudoCancelled extends Error {
  constructor() {
    super("sudo cancelled");
  }
}

interface SudoApi {
  /** Does `action` with a valid sudo token, asking for one first if there is none. Rejects with SudoCancelled if they back out. */
  run<T>(action: (sudoToken: string) => Promise<T>): Promise<T>;
  /** When the current confirmation ends, or null if there is none. */
  confirmedUntil: Date | null;
}

const SudoContext = createContext<SudoApi | null>(null);

/** A token with less than this left is treated as gone, so an action never starts with one that runs out on the way. */
const MARGIN_MS = 10_000;

export function SudoProvider({ children }: { children: ReactNode }) {
  const held = useRef<{ token: string; expiresAt: number } | null>(null);
  const [confirmedUntil, setConfirmedUntil] = useState<Date | null>(null);
  // One question at a time: two actions started together share the one confirmation.
  const asking = useRef<Promise<string> | null>(null);
  const settle = useRef<{ resolve: (token: string) => void; reject: (error: Error) => void } | null>(null);
  const [open, setOpen] = useState(false);
  // Each question is a new dialog: asking again straight after an answer must not reuse the last one, with its old words and its busy button.
  const [question, setQuestion] = useState(0);

  const ensure = useCallback((): Promise<string> => {
    const current = held.current;
    if (current && current.expiresAt - Date.now() > MARGIN_MS) return Promise.resolve(current.token);
    if (asking.current) return asking.current;
    const promise = new Promise<string>((resolve, reject) => {
      settle.current = { resolve, reject };
    });
    asking.current = promise;
    setQuestion((n) => n + 1);
    setOpen(true);
    return promise;
  }, []);

  const forget = useCallback(() => {
    held.current = null;
    setConfirmedUntil(null);
  }, []);

  const run = useCallback(
    async <T,>(action: (sudoToken: string) => Promise<T>): Promise<T> => {
      try {
        return await action(await ensure());
      } catch (err) {
        if (!isSudoRequired(err)) throw err;
        // The server no longer accepts it (a restart, a clock): ask again, once.
        forget();
        return await action(await ensure());
      }
    },
    [ensure, forget]
  );

  const confirmed = (token: string, expiresAt: string) => {
    held.current = { token, expiresAt: Date.parse(expiresAt) };
    setConfirmedUntil(new Date(held.current.expiresAt));
    const waiting = settle.current;
    settle.current = null;
    asking.current = null;
    setOpen(false);
    waiting?.resolve(token);
  };
  const cancelled = () => {
    const waiting = settle.current;
    settle.current = null;
    asking.current = null;
    setOpen(false);
    waiting?.reject(new SudoCancelled());
  };

  const value = useMemo<SudoApi>(() => ({ run, confirmedUntil }), [run, confirmedUntil]);
  return (
    <SudoContext.Provider value={value}>
      {children}
      {open && <SudoDialog key={question} onConfirmed={confirmed} onCancel={cancelled} />}
    </SudoContext.Provider>
  );
}

export function useSudo(): SudoApi {
  const value = useContext(SudoContext);
  if (!value) throw new Error("useSudo needs a SudoProvider");
  return value;
}

function SudoDialog({ onConfirmed, onCancel }: { onConfirmed: (token: string, expiresAt: string) => void; onCancel: () => void }) {
  const passwordId = useId();
  const codeId = useId();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // A recovery code is longer than the six digits an authenticator shows.
      const trimmed = code.trim();
      const proof = /^\d{6}$/u.test(trimmed) ? { code: trimmed } : { recoveryCode: trimmed };
      const { sudoToken, expiresAt } = await api.adminSudo({ password, ...proof });
      onConfirmed(sudoToken, expiresAt);
    } catch (err) {
      setError(adminErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Confirm it is you" onClose={onCancel}>
      <form onSubmit={submit} className="data-export-form">
        <p className="hint">
          This changes something for other people, so the admin page asks for your password and a code from your authenticator app again. It stays
          confirmed for ten minutes.
        </p>
        <label htmlFor={passwordId}>Your password</label>
        <input id={passwordId} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        <label htmlFor={codeId}>Code from your authenticator app (or a recovery code)</label>
        <input id={codeId} type="text" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
        {error && <p className="error-text">{error}</p>}
        <div className="data-export-form-buttons">
          <Button type="submit" busy={busy} disabled={!password || !code.trim()}>
            Confirm
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
