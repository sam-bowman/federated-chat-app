import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as api from "../../api";
import type { AdminRegistrationInvite, AdminRegistrationInvites, NewRegistrationInvites } from "../../api";
import { adminErrorMessage } from "../../lib/adminText";
import { INVITE_LIMITS, INVITE_STATUS_WORDS, inviteLink, inviteSummary, whole } from "../../lib/adminInvites";
import { noAutofill } from "../../lib/noAutofill";
import Button from "../Button";
import ConfirmModal from "../ConfirmModal";
import Modal from "../Modal";
import { SudoCancelled, useSudo } from "./SudoContext";

type Dialog = { kind: "make" } | { kind: "revoke"; invite: AdminRegistrationInvite } | null;

/**
 * The registration invites (#206): the codes an invite-only server asks for. An admin makes them (with a limit on uses and a lifetime, and a note
 * for themselves), copies a code or a link to give out, and revokes one. Making and revoking go through sudo mode and are written to the audit log
 * by the server, which never writes the code itself: a code is a credential, shown only here.
 */
export default function AdminInvites() {
  const sudo = useSudo();
  const [showAll, setShowAll] = useState(false);
  const [data, setData] = useState<AdminRegistrationInvites | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [justMade, setJustMade] = useState<AdminRegistrationInvite[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Only the latest question may answer.
  const asked = useRef(0);

  useEffect(() => {
    const mine = ++asked.current;
    api
      .listAdminRegistrationInvites(showAll)
      .then((result) => {
        if (mine !== asked.current) return;
        setData(result);
        setError(null);
      })
      .catch(() => mine === asked.current && setError("Couldn't load the invites. Try again."))
      .finally(() => mine === asked.current && setLoading(false));
  }, [showAll, reload]);

  /** Does one change in sudo mode. A confirmation they back out of is not an error. */
  const act = useCallback(
    async (action: (sudoToken: string) => Promise<void>) => {
      setBusy(true);
      setActionError(null);
      try {
        await sudo.run(action);
        setReload((n) => n + 1);
      } catch (err) {
        if (!(err instanceof SudoCancelled)) setActionError(adminErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [sudo]
  );

  const make = (options: NewRegistrationInvites) =>
    act(async (token) => {
      const made = await api.adminCreateRegistrationInvites(options, token);
      setJustMade(made.invites);
    });

  const revoke = (invite: AdminRegistrationInvite) =>
    act(async (token) => {
      await api.adminRevokeRegistrationInvite(invite.id, token);
      setJustMade((current) => current?.filter((i) => i.id !== invite.id) ?? null);
    });

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setActionError(null);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000);
    } catch {
      setCopied(null);
      setActionError("Could not copy to the clipboard. Select the code and copy it by hand.");
    }
  }

  const invites = data?.invites ?? [];
  return (
    <div className="admin-invites">
      <p className="hint">
        When this server is invite-only, a person needs a code to make an account. A code is a credential: whoever has it can register, so give it only to the person it is for.
        Revoking a code stops it being used; the accounts already made with it stay.
      </p>
      {data && !data.registration.enabled && (
        <p className="hint" role="note">
          Registration is switched off on this server (<code>REGISTRATION_ENABLED=false</code>), so nobody can make an account yet, with or without a code.
        </p>
      )}
      {data && data.registration.enabled && !data.registration.inviteOnly && (
        <p className="hint" role="note">
          This server is not invite-only (<code>REGISTRATION_INVITE_ONLY</code> is not true), so a code is not asked for yet. Codes made now work once it is.
        </p>
      )}

      <div className="admin-invites-toolbar">
        <Button type="button" busy={busy} onClick={() => setDialog({ kind: "make" })}>
          Make invites…
        </Button>
        <label className="remember-option">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => {
              setShowAll(e.target.checked);
              setLoading(true);
            }}
          />
          Show revoked, expired and used up
        </label>
      </div>

      {actionError && <p className="error-text">{actionError}</p>}

      {justMade && justMade.length > 0 && (
        <div className="admin-invites-made" role="status">
          <strong>{justMade.length === 1 ? "Made 1 invite." : `Made ${justMade.length} invites.`}</strong>{" "}
          {justMade.length === 1 ? "It is at the top of the list." : "They are at the top of the list."}
          <div className="admin-user-actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => void copy(justMade.map((i) => i.code).join("\n"), "made-codes")}>
              {justMade.length === 1 ? "Copy the code" : "Copy the codes"}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => void copy(justMade.map((i) => inviteLink(i.code)).join("\n"), "made-links")}>
              {justMade.length === 1 ? "Copy the link" : "Copy the links"}
            </Button>
            {(copied === "made-codes" || copied === "made-links") && <span>Copied to the clipboard.</span>}
          </div>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      {loading && !data && <p className="hint">Loading…</p>}
      {!error && !loading && data && invites.length === 0 && (
        <div className="empty-state">{showAll ? "There are no registration invites." : "There are no invites that can still be used."}</div>
      )}

      {invites.length > 0 && (
        <ul className="admin-invites-rows" aria-label="Registration invites">
          {invites.map((invite) => (
            <li key={invite.id} className="admin-invite-row" data-status={invite.status}>
              <div className="admin-invite-main">
                <code className="admin-invite-code">{invite.code}</code>
                <span className="admin-invite-status">{INVITE_STATUS_WORDS[invite.status]}</span>
              </div>
              <div className="hint">{inviteSummary(invite)}</div>
              {invite.note && <div className="admin-invite-note">Note: {invite.note}</div>}
              {invite.joined.length > 0 && <div className="hint">Joined: {invite.joined.join(", ")}</div>}
              {invite.status === "active" && (
                <div className="admin-user-actions">
                  <Button type="button" variant="secondary" size="sm" onClick={() => void copy(invite.code, `code-${invite.id}`)}>
                    {copied === `code-${invite.id}` ? "Copied" : "Copy code"}
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => void copy(inviteLink(invite.code), `link-${invite.id}`)}>
                    {copied === `link-${invite.id}` ? "Copied" : "Copy link"}
                  </Button>
                  <Button type="button" variant="danger" size="sm" busy={busy} onClick={() => setDialog({ kind: "revoke", invite })}>
                    Revoke…
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && data.total > invites.length && (
        <p className="hint" role="status">
          Showing the newest {invites.length} of {data.total}.
        </p>
      )}
      {data && data.total <= invites.length && invites.length > 0 && (
        <p className="hint" role="status">
          {invites.length} invite{invites.length === 1 ? "" : "s"}
        </p>
      )}

      {dialog?.kind === "make" && <MakeInvitesDialog onClose={() => setDialog(null)} onSubmit={(options) => void make(options)} />}
      {dialog?.kind === "revoke" && (
        <ConfirmModal
          title="Revoke this invite?"
          message={`The code ending ${dialog.invite.code.slice(-4)} stops working at once. People who already made an account with it keep theirs.`}
          confirmLabel="Revoke"
          danger
          onConfirm={() => void revoke(dialog.invite)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function MakeInvitesDialog({ onSubmit, onClose }: { onSubmit: (options: NewRegistrationInvites) => void; onClose: () => void }) {
  const usesId = useId();
  const daysId = useId();
  const noteId = useId();
  const countId = useId();
  const [uses, setUses] = useState(String(INVITE_LIMITS.defaultUses));
  const [noLimit, setNoLimit] = useState(false);
  const [days, setDays] = useState(String(INVITE_LIMITS.defaultDays));
  const [never, setNever] = useState(false);
  const [note, setNote] = useState("");
  const [count, setCount] = useState("1");

  const maxUses = noLimit ? null : whole(uses, 1, INVITE_LIMITS.maxUses);
  const expiresInDays = never ? null : whole(days, 1, INVITE_LIMITS.maxDays);
  const howMany = whole(count, 1, INVITE_LIMITS.maxCount);
  const ready = maxUses !== undefined && expiresInDays !== undefined && howMany !== undefined;

  return (
    <Modal title="Make registration invites" onClose={onClose}>
      <form
        className="data-export-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          onSubmit({ maxUses, expiresInDays, note: note.trim() || undefined, count: howMany });
          onClose();
        }}
      >
        <label htmlFor={usesId}>Accounts each code can make</label>
        <input id={usesId} type="number" {...noAutofill} min={1} max={INVITE_LIMITS.maxUses} inputMode="numeric" disabled={noLimit} value={uses} onChange={(e) => setUses(e.target.value)} />
        <label className="remember-option">
          <input type="checkbox" checked={noLimit} onChange={(e) => setNoLimit(e.target.checked)} />
          No limit
        </label>

        <label htmlFor={daysId}>Days until each code ends</label>
        <input id={daysId} type="number" {...noAutofill} min={1} max={INVITE_LIMITS.maxDays} inputMode="numeric" disabled={never} value={days} onChange={(e) => setDays(e.target.value)} />
        <label className="remember-option">
          <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
          Never ends
        </label>

        <label htmlFor={noteId}>Note (a reminder for you, never shown to them)</label>
        <input id={noteId} type="text" {...noAutofill} maxLength={INVITE_LIMITS.maxNote} placeholder="who it is for" value={note} onChange={(e) => setNote(e.target.value)} />

        <label htmlFor={countId}>How many codes to make</label>
        <input id={countId} type="number" {...noAutofill} min={1} max={INVITE_LIMITS.maxCount} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />

        {!ready && <p className="error-text">Check the numbers: uses 1 to {INVITE_LIMITS.maxUses}, days 1 to {INVITE_LIMITS.maxDays}, codes 1 to {INVITE_LIMITS.maxCount}.</p>}
        <div className="data-export-form-buttons">
          <Button type="submit" disabled={!ready}>
            Make
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
