import { useEffect, useId, useRef, useState } from "react";
import * as api from "../../api";
import type { AdminCommunityPage } from "../../api";
import { noAutofill } from "../../lib/noAutofill";
import Button from "../Button";
import AdminCommunityDetailPanel from "./AdminCommunityDetailPanel";

const PAGE_SIZE = 25;

/**
 * The communities this server hosts (#206), a page at a time, with a search by name. Choosing one shows what it is made of and what an admin can do
 * about it: hand it to another member, or delete it. A copy of another server's community is not ours to manage, and the server does not list it.
 * It uses the users section's layout (the `admin-users*` styles), since the two are the same shape: a list on one side, the chosen one on the other.
 */
export default function AdminCommunities() {
  const searchId = useId();
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AdminCommunityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Only the latest question may answer: typing another search while an older one is on its way must not show the older answer.
  const asked = useRef(0);

  useEffect(() => {
    const mine = ++asked.current;
    api
      .listAdminCommunities({ search, offset, limit: PAGE_SIZE })
      .then((result) => {
        if (mine !== asked.current) return;
        setPage(result);
        setError(null);
      })
      .catch(() => mine === asked.current && setError("Couldn't load the communities. Try again."))
      .finally(() => mine === asked.current && setLoading(false));
  }, [search, offset, reload]);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setSearch(typed.trim());
    setOffset(0);
    setLoading(true);
    // Always ask again, even for the same words (pressing Search twice): otherwise nothing changes, nothing is fetched, and the list would wait
    // for an answer that is never coming.
    setReload((n) => n + 1);
  };

  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="admin-users">
      <div className="admin-users-list">
        <form className="admin-users-search" onSubmit={submitSearch} role="search">
          <label htmlFor={searchId}>Find a community</label>
          <input id={searchId} type="search" {...noAutofill} value={typed} placeholder="part of the name" onChange={(e) => setTyped(e.target.value)} />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        {error && <p className="error-text">{error}</p>}
        {!error && !loading && page && page.communities.length === 0 && <div className="empty-state">No communities match.</div>}
        {loading && !page && <p className="hint">Loading…</p>}

        {page && page.communities.length > 0 && (
          <ul className="admin-users-rows" aria-label="Communities">
            {page.communities.map((community) => (
              <li key={community.id}>
                <button type="button" className="admin-user-row" aria-current={selected === community.id ? "true" : undefined} onClick={() => setSelected(community.id)}>
                  <span className="admin-user-name">{community.name}</span>
                  <span className="admin-user-identity">Owner {community.owner}</span>
                  <span className="admin-user-flags">
                    {community.members} member{community.members === 1 ? "" : "s"} · {community.channels} channel{community.channels === 1 ? "" : "s"}
                  </span>
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
            {total} communit{total === 1 ? "y" : "ies"}
          </p>
        )}
      </div>

      <div className="admin-users-detail">
        {selected ? (
          <AdminCommunityDetailPanel
            key={selected}
            id={selected}
            onChanged={() => setReload((n) => n + 1)}
            onGone={() => {
              setSelected(null);
              setReload((n) => n + 1);
            }}
          />
        ) : (
          <p className="hint">Choose a community to see it and what you can do about it.</p>
        )}
      </div>
    </div>
  );
}
