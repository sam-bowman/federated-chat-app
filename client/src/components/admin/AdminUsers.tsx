import { useEffect, useId, useRef, useState } from "react";
import * as api from "../../api";
import type { AdminUser, AdminUserPage } from "../../api";
import { noAutofill } from "../../lib/noAutofill";
import Button from "../Button";
import AdminUserDetailPanel from "./AdminUserDetailPanel";

const PAGE_SIZE = 25;

/** The flags that matter at a glance, as words (never colour alone). */
export function userFlags(user: Pick<AdminUser, "admin" | "suspended" | "deletionPending" | "twoFactor">): string[] {
  return [user.admin ? "Admin" : "", user.suspended ? "Suspended" : "", user.deletionPending ? "Being deleted" : "", user.twoFactor ? "" : "No 2FA"].filter(Boolean);
}

/**
 * The accounts on this server (#206), a page at a time, with a search and two filters. Choosing one shows what an admin can do to it. Only accounts
 * on THIS server: a cached copy of someone on another server is not ours to manage, and the server does not list it.
 */
export default function AdminUsers() {
  const searchId = useId();
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [suspendedOnly, setSuspendedOnly] = useState(false);
  const [adminsOnly, setAdminsOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AdminUserPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Only the latest question may answer: typing another search while an older one is on its way must not show the older answer.
  const asked = useRef(0);

  useEffect(() => {
    const mine = ++asked.current;
    api
      .listAdminUsers({ search, suspended: suspendedOnly, admin: adminsOnly ? true : undefined, offset, limit: PAGE_SIZE })
      .then((result) => {
        if (mine !== asked.current) return;
        setPage(result);
        setError(null);
      })
      .catch(() => mine === asked.current && setError("Couldn't load the accounts. Try again."))
      .finally(() => mine === asked.current && setLoading(false));
  }, [search, suspendedOnly, adminsOnly, offset, reload]);

  const choose = (apply: () => void) => {
    apply();
    setOffset(0);
    setLoading(true);
    // Always ask again, even when what was chosen is what was already chosen (pressing Search twice): otherwise nothing changes, nothing
    // is fetched, and the list would wait for an answer that is never coming.
    setReload((n) => n + 1);
  };
  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    choose(() => setSearch(typed.trim()));
  };

  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="admin-users">
      <div className="admin-users-list">
        <form className="admin-users-search" onSubmit={submitSearch} role="search">
          <label htmlFor={searchId}>Find an account</label>
          <input id={searchId} type="search" {...noAutofill} value={typed} placeholder="username or name" onChange={(e) => setTyped(e.target.value)} />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <div className="admin-users-filters">
          <label className="remember-option">
            <input type="checkbox" checked={suspendedOnly} onChange={(e) => choose(() => setSuspendedOnly(e.target.checked))} />
            Suspended only
          </label>
          <label className="remember-option">
            <input type="checkbox" checked={adminsOnly} onChange={(e) => choose(() => setAdminsOnly(e.target.checked))} />
            Admins only
          </label>
        </div>

        {error && <p className="error-text">{error}</p>}
        {!error && !loading && page && page.users.length === 0 && <div className="empty-state">No accounts match.</div>}
        {loading && !page && <p className="hint">Loading…</p>}

        {page && page.users.length > 0 && (
          <ul className="admin-users-rows" aria-label="Accounts">
            {page.users.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  className="admin-user-row"
                  aria-current={selected === user.username ? "true" : undefined}
                  onClick={() => setSelected(user.username)}
                >
                  <span className="admin-user-name">{user.displayName}</span>
                  <span className="admin-user-identity">{user.identity}</span>
                  {userFlags(user).length > 0 && <span className="admin-user-flags">{userFlags(user).join(" · ")}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {page && total > PAGE_SIZE && (
          <div className="admin-users-pager">
            <Button type="button" variant="secondary" size="sm" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              Previous
            </Button>
            <span role="status">
              {first}–{last} of {total}
            </span>
            <Button type="button" variant="secondary" size="sm" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>
              Next
            </Button>
          </div>
        )}
        {page && total <= PAGE_SIZE && total > 0 && (
          <p className="hint" role="status">
            {total} account{total === 1 ? "" : "s"}
          </p>
        )}
      </div>

      <div className="admin-users-detail">
        {selected ? (
          <AdminUserDetailPanel
            key={selected}
            username={selected}
            onChanged={() => setReload((n) => n + 1)}
            onGone={() => {
              setSelected(null);
              setReload((n) => n + 1);
            }}
          />
        ) : (
          <p className="hint">Choose an account to see it and what you can do to it.</p>
        )}
      </div>
    </div>
  );
}
