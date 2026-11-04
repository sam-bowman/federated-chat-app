import { useState } from "react";
import { getActiveId } from "../lib/accountSessions";
import { listAccountSessions } from "../api/client";
import { useAuth } from "../context/AuthContext";
import Button from "./Button";
import Modal from "./Modal";

/**
 * The accounts signed in on this device (#49): switch to one, sign one out, or add another. Using another account loads the app afresh as
 * them (the one way to be sure nothing of the previous person is left in memory), and only the account in use is connected: the others
 * are not told anything and raise no alerts until you switch to them. `serverName` and the identity come from the server, so they are text.
 */
export default function AccountsDialog({ onClose, onAddAccount }: { onClose: () => void; onAddAccount: () => void }) {
  const { user, switchAccount, signOutAccount } = useAuth();
  const [accounts, setAccounts] = useState(() => listAccountSessions());
  const activeId = getActiveId();

  function signOut(id: string) {
    signOutAccount(id);
    // Signing out the account in use leaves the page (to another account, or to the sign-in page); anything else is just gone from the list.
    setAccounts(listAccountSessions());
  }

  return (
    <Modal title="Accounts" onClose={onClose} width={440}>
      <p className="hint">
        These accounts are signed in on this device. Only the one you are using is connected; the others do not alert you until you switch
        to them.
      </p>
      <ul className="accounts-dialog-list" aria-label="Signed-in accounts">
        {accounts.map((account) => {
          const current = account.id === activeId;
          // A session carried over from before accounts were kept has no name until the server has said whose it is.
          const identity = account.username ? `@${account.username}:${account.domain || "…"}` : (user?.identity ?? "…");
          return (
            <li key={account.id} className="accounts-dialog-row">
              <span className="accounts-dialog-who">
                <span className="accounts-dialog-identity">{identity}</span>
                <span className="accounts-dialog-meta">
                  {account.serverName || account.domain || account.origin}
                  {current ? " · in use" : ""}
                </span>
              </span>
              {!current && (
                <Button type="button" size="sm" variant="secondary" aria-label={`Switch to ${identity}`} onClick={() => switchAccount(account.id)}>
                  Switch
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" aria-label={`Sign out ${identity}`} onClick={() => signOut(account.id)}>
                Sign out
              </Button>
            </li>
          );
        })}
      </ul>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          onClose();
          onAddAccount();
        }}
        style={{ alignSelf: "flex-start", marginTop: "0.75rem" }}
      >
        Add another account
      </Button>
    </Modal>
  );
}
