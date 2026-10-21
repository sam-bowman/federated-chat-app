import { useCallback, useEffect, useId, useState } from "react";
import * as api from "../../api";
import type { AdminUserDetail } from "../../api";
import { adminErrorMessage } from "../../lib/adminText";
import Button from "../Button";
import ConfirmModal from "../ConfirmModal";
import Modal from "../Modal";
import { SudoCancelled, useSudo } from "./SudoContext";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

type Dialog = "suspend" | "reset" | "disable2fa" | "delete" | "makeAdmin" | "removeAdmin" | null;

/**
 * One account and what an admin can do to it (#206). Every action goes through sudo mode, answers with the account as it now is, and is written to
 * the audit log by the server. An account that is an admin can only have admin taken away here: the server refuses the rest, and says why, so the
 * buttons are not even offered.
 */
export default function AdminUserDetailPanel({ username, onChanged, onGone }: { username: string; onChanged: () => void; onGone: () => void }) {
  const sudo = useSudo();
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    let current = true;
    api
      .getAdminUser(username)
      .then((r) => current && setUser(r.user))
      .catch((err) => current && setLoadError(adminErrorMessage(err)));
    return () => {
      current = false;
    };
  }, [username]);

  /** Does one action in sudo mode and shows the result: the account as it is now, or an explanation. A confirmation they back out of is not an error. */
  const act = useCallback(
    async (action: (sudoToken: string) => Promise<{ user: AdminUserDetail } | { erased: true }>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await sudo.run(action);
        if ("erased" in result) {
          onGone();
          return;
        }
        setUser(result.user);
        onChanged();
      } catch (err) {
        if (!(err instanceof SudoCancelled)) setError(adminErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [sudo, onChanged, onGone]
  );

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!user) return <p className="hint">Loading…</p>;

  const name = user.username;
  return (
    <section className="admin-user" aria-label={`Account ${user.identity}`}>
      <h4>{user.displayName}</h4>
      <p className="hint">{user.identity}</p>

      <dl className="admin-user-facts">
        <dt>Joined</dt>
        <dd>{when(user.createdAt)}</dd>
        <dt>Last seen</dt>
        <dd>{when(user.lastSeenAt)}</dd>
        <dt>Two-factor sign-in</dt>
        <dd>{user.twoFactor ? "On" : "Off"}</dd>
        <dt>Admin</dt>
        <dd>{user.admin ? "Yes" : "No"}</dd>
        <dt>Account</dt>
        <dd>{user.suspended ? `Suspended since ${when(user.suspendedAt)}` : "Active"}</dd>
        <dt>Sessions</dt>
        <dd>{user.activeSessions} that can be refreshed</dd>
        <dt>Communities</dt>
        <dd>
          Owns {user.communitiesOwned}
          {user.ownedCommunities.length > 0 && ` (${user.ownedCommunities.map((c) => c.name).join(", ")})`}, in {user.communitiesJoined}
        </dd>
        {user.registrationInviteNote && (
          <>
            <dt>Joined with an invite noted</dt>
            <dd>{user.registrationInviteNote}</dd>
          </>
        )}
        {user.deletionPending && (
          <>
            <dt>Deletion</dt>
            <dd>
              Asked for {when(user.deletionRequestedAt)}; erased {when(user.deletionScheduledFor)} unless they sign in first
            </dd>
          </>
        )}
      </dl>

      {error && <p className="error-text">{error}</p>}

      {user.admin ? (
        <div className="admin-user-actions">
          <p className="hint">
            This account is an admin, so it can only be changed here by taking admin away. To suspend it, delete it or change its password or two-factor sign-in, remove admin first
            (or use the command line).
          </p>
          <Button type="button" variant="danger" busy={busy} onClick={() => setDialog("removeAdmin")}>
            Remove admin
          </Button>
        </div>
      ) : (
        <div className="admin-user-actions">
          {user.suspended ? (
            <Button type="button" variant="secondary" busy={busy} onClick={() => void act((t) => api.adminUnsuspend(name, t))}>
              Unsuspend
            </Button>
          ) : (
            <Button type="button" variant="secondary" busy={busy} onClick={() => setDialog("suspend")}>
              Suspend…
            </Button>
          )}
          <Button type="button" variant="secondary" busy={busy} onClick={() => setDialog("reset")}>
            Set a new password…
          </Button>
          {user.twoFactor && (
            <Button type="button" variant="secondary" busy={busy} onClick={() => setDialog("disable2fa")}>
              Turn off two-factor…
            </Button>
          )}
          {user.deletionPending ? (
            <Button type="button" variant="secondary" busy={busy} onClick={() => void act((t) => api.adminCancelDeletion(name, t))}>
              Cancel the deletion
            </Button>
          ) : null}
          <Button type="button" variant="danger" busy={busy} onClick={() => setDialog("delete")}>
            {user.deletionPending ? "Erase now…" : "Delete…"}
          </Button>
          {!user.suspended && (
            <Button type="button" variant="secondary" busy={busy} onClick={() => setDialog("makeAdmin")}>
              Make admin…
            </Button>
          )}
        </div>
      )}

      {dialog === "suspend" && (
        <ConfirmModal
          title={`Suspend ${user.identity}?`}
          message="They are signed out everywhere and cannot sign in until you unsuspend them."
          confirmLabel="Suspend"
          danger
          onConfirm={() => void act((t) => api.adminSuspend(name, t))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "disable2fa" && (
        <ConfirmModal
          title={`Turn off two-factor sign-in for ${user.identity}?`}
          message="Only do this once you are sure it is them, for example after they lost their authenticator. Their recovery codes are deleted too."
          confirmLabel="Turn off"
          danger
          onConfirm={() => void act((t) => api.adminDisableTwoFactor(name, t))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "makeAdmin" && (
        <ConfirmModal
          title={`Make ${user.identity} an admin?`}
          message="They will be able to see and change things for everyone on this server, once they have turned on two-factor sign-in."
          confirmLabel="Make admin"
          danger
          onConfirm={() => void act((t) => api.adminSetAdmin(name, true, t))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "removeAdmin" && (
        <ConfirmModal
          title={`Remove admin from ${user.identity}?`}
          message="They lose access to this page at once. It does not change anything else about the account."
          confirmLabel="Remove admin"
          danger
          onConfirm={() => void act((t) => api.adminSetAdmin(name, false, t))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "reset" && (
        <ResetPasswordDialog
          identity={user.identity}
          onClose={() => setDialog(null)}
          onSubmit={(password) => void act((t) => api.adminResetPassword(name, password, t))}
        />
      )}
      {dialog === "delete" && (
        <DeleteDialog
          user={user}
          onClose={() => setDialog(null)}
          onSubmit={(options) => void act((t) => api.adminDeleteUser(name, options, t))}
        />
      )}
    </section>
  );
}

function ResetPasswordDialog({ identity, onSubmit, onClose }: { identity: string; onSubmit: (password: string) => void; onClose: () => void }) {
  const firstId = useId();
  const secondId = useId();
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const matches = first !== "" && first === second;
  return (
    <Modal title={`New password for ${identity}`} onClose={onClose}>
      <form
        className="data-export-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!matches) return;
          onSubmit(first);
          onClose();
        }}
      >
        <p className="hint">
          Everyone signed in as them is signed out, and they sign in with this one. It has to follow the sign-up rules: 8 or more characters with an uppercase letter, a lowercase
          letter, a number and a symbol. Tell it to them privately.
        </p>
        <label htmlFor={firstId}>New password</label>
        <input id={firstId} type="password" autoComplete="new-password" autoFocus value={first} onChange={(e) => setFirst(e.target.value)} />
        <label htmlFor={secondId}>Again</label>
        <input id={secondId} type="password" autoComplete="new-password" value={second} onChange={(e) => setSecond(e.target.value)} />
        {second !== "" && !matches && <p className="error-text">The two are not the same.</p>}
        <div className="data-export-form-buttons">
          <Button type="submit" disabled={!matches}>
            Set the password
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog({ user, onSubmit, onClose }: { user: AdminUserDetail; onSubmit: (options: { now?: boolean; confirm?: string }) => void; onClose: () => void }) {
  const confirmId = useId();
  // An account already waiting to be deleted can only be erased now: asking again changes nothing.
  const [now, setNow] = useState(user.deletionPending);
  const [typed, setTyped] = useState("");
  const ready = !now || typed.trim().toLowerCase() === user.username;
  return (
    <Modal title={`Delete ${user.identity}`} onClose={onClose}>
      <form
        className="data-export-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onSubmit(now ? { now: true, confirm: typed } : {});
          onClose();
        }}
      >
        {!user.deletionPending && (
          <label className="remember-option">
            <input type="radio" name="delete-mode" checked={!now} onChange={() => setNow(false)} />
            Delete after the waiting period: they are signed out, and the account is erased unless they sign in before then
          </label>
        )}
        <label className="remember-option">
          <input type="radio" name="delete-mode" checked={now} onChange={() => setNow(true)} />
          Erase now: their messages, friendships, memberships and files are removed for good, and other servers are told. This cannot be undone
        </label>
        {user.communitiesOwned > 0 && <p className="hint">They own a community, which would be left without an owner: the server will refuse until it is handed on or deleted.</p>}
        {now && (
          <>
            <label htmlFor={confirmId}>
              Type their username, <strong>{user.username}</strong>, to confirm
            </label>
            <input id={confirmId} type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </>
        )}
        <div className="data-export-form-buttons">
          <Button type="submit" variant="danger" disabled={!ready}>
            {now ? "Erase now" : "Delete"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
