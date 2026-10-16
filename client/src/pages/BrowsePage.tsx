import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as api from "../api";
import type { DirectoryCommunity, DirectoryPerson } from "../api";
import { ApiError } from "../api/client";
import Avatar from "../components/Avatar";
import Button from "../components/Button";
import { TileFace, tileProps } from "../components/CommunityTile";
import Tabs from "../components/Tabs";
import { useAppData } from "../context/AppDataContext";
import { directoryFailureMessage, normalizeServerInput } from "../lib/directory";
import { useFederationEnabled } from "../lib/federation";
import { friendRequestFailure } from "../lib/friendRequest";
import { joinByIdFailureMessage } from "../lib/invite";
import { noAutofill } from "../lib/noAutofill";

type Kind = "communities" | "people";
type Results = { kind: "communities"; items: DirectoryCommunity[] } | { kind: "people"; items: DirectoryPerson[] };
type Load = { status: "loading" } | { status: "ready" } | { status: "failed"; message: string };

/**
 * Browse (#109, phase 5): the communities a server lists as public and the people who chose to be listed, this server's own or
 * another's. Another server's is asked for through this one (never from the browser), so the rules of this server hold, and what comes
 * back has been checked on the way. Everything shown is another person's text: it is only ever put on the page as text.
 */
export default function BrowsePage() {
  const { communities, friends, refreshCommunities } = useAppData();
  const federating = useFederationEnabled();
  const navigate = useNavigate();

  const [kind, setKind] = useState<Kind>("communities");
  // The server being browsed: null is the person's own.
  const [server, setServer] = useState<string | null>(null);
  const [serverInput, setServerInput] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Results>({ kind: "communities", items: [] });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  // What happened to the row someone pressed a button on (a join, a friend request), by id.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // A response to an older question is dropped, so a slow server cannot overwrite a newer one.
  const asked = useRef(0);

  async function fetchPage(cursor: string | null) {
    const query = { domain: server, q, cursor };
    return kind === "communities"
      ? ({ kind, ...(await api.listDirectoryCommunities(query)) } as const)
      : ({ kind, ...(await api.listDirectoryPeople(query)) } as const);
  }

  function failureOf(err: unknown): Load {
    const status = err instanceof ApiError ? err.status : undefined;
    const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
    return { status: "failed", message: directoryFailureMessage(status, code, server) };
  }

  useEffect(() => {
    const mine = ++asked.current;
    setLoad({ status: "loading" });
    setNotes({});
    fetchPage(null)
      .then((page) => {
        if (asked.current !== mine) return;
        setResults(page.kind === "communities" ? { kind: "communities", items: page.items } : { kind: "people", items: page.items });
        setNextCursor(page.nextCursor);
        setLoad({ status: "ready" });
      })
      .catch((err) => {
        if (asked.current !== mine) return;
        setResults({ kind, items: [] } as Results);
        setNextCursor(null);
        setLoad(failureOf(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, server, q]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const mine = asked.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      if (asked.current !== mine) return;
      // Nothing is shown twice, even if the server repeats one.
      setResults((prev) => {
        const seen = new Set(prev.items.map((i) => i.id));
        const fresh = page.items.filter((i) => !seen.has(i.id));
        return { kind: page.kind, items: [...prev.items, ...fresh] } as Results;
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (asked.current === mine) setLoad(failureOf(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function join(item: DirectoryCommunity) {
    const reference = `${item.id}:${item.domain}`;
    setBusy(item.id);
    setNotes((n) => ({ ...n, [item.id]: "" }));
    try {
      await api.joinCommunity(reference);
      await refreshCommunities();
      navigate(`/communities/${item.id}`);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setNotes((n) => ({ ...n, [item.id]: joinByIdFailureMessage(status, code, reference) }));
    } finally {
      setBusy(null);
    }
  }

  async function addFriend(person: DirectoryPerson) {
    setBusy(person.id);
    setNotes((n) => ({ ...n, [person.id]: "" }));
    try {
      await api.sendFriendRequest(`${person.username}:${person.domain}`);
      setNotes((n) => ({ ...n, [person.id]: "Friend request sent." }));
    } catch (err) {
      setNotes((n) => ({ ...n, [person.id]: friendRequestFailure((err as { body?: { error?: string } })?.body?.error).message }));
    } finally {
      setBusy(null);
    }
  }

  function chooseServer(e: React.FormEvent) {
    e.preventDefault();
    setServer(normalizeServerInput(serverInput));
  }

  const heading = server ?? "this server";
  const joined = new Set(communities.map((c) => c.id));
  const friendIdentities = new Set(friends.map((f) => f.identity.toLowerCase()));

  return (
    <>
      <div className="main-header">Browse</div>
      <div className="panel">
        {federating && (
          <form className="browse-server" onSubmit={chooseServer}>
            <input
              {...noAutofill}
              name="browse-server"
              aria-label="Server to browse"
              placeholder="Another server, for example chat.example.com (blank for this one)"
              value={serverInput}
              onChange={(e) => setServerInput(e.target.value)}
            />
            <Button type="submit" variant="secondary">
              Browse
            </Button>
          </form>
        )}

        <p className="hint">
          {server ? (
            <>
              What <strong>{server}</strong> lists.{" "}
              <Button
                variant="link"
                onClick={() => {
                  setServer(null);
                  setServerInput("");
                }}
              >
                Back to this server
              </Button>
            </>
          ) : (
            "What this server lists."
          )}
        </p>

        <form
          className="browse-server"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(search.trim());
          }}
        >
          <input
            {...noAutofill}
            name="browse-search"
            type="search"
            aria-label={kind === "communities" ? "Search communities" : "Search people"}
            placeholder={kind === "communities" ? "Search communities by name or description" : "Search people by name"}
            value={search}
            maxLength={64}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        <Tabs
          label="What to browse"
          value={kind}
          onChange={(next) => {
            setKind(next);
            setResults({ kind: next, items: [] } as Results);
          }}
          minHeight="14rem"
          tabs={[
            { id: "communities", label: "Communities" },
            { id: "people", label: "People" },
          ]}
        >
          {load.status === "loading" && <div className="empty-state">Loading…</div>}
          {load.status === "failed" && (
            <div className="error-text" role="alert">
              {load.message}
            </div>
          )}
          {load.status === "ready" && results.items.length === 0 && (
            <div className="empty-state">
              {q
                ? `Nothing matches "${q}" on ${heading}.`
                : kind === "communities"
                  ? `${server ?? "This server"} lists no communities yet.`
                  : `No one on ${heading} has chosen to be listed yet.`}
            </div>
          )}

          {results.kind === "communities" &&
            results.items.map((item) => {
              const tile = tileProps(item);
              return (
                <div key={item.id} className="friend-request-row browse-row">
                  <span className={`rail-item rail-community browse-tile${tile.className}`} style={tile.style} aria-hidden="true">
                    <TileFace community={item} />
                  </span>
                  <div className="grow">
                    <div className="browse-name">{item.name}</div>
                    {item.description && <div className="hint browse-description">{item.description}</div>}
                    <div className="hint">
                      {item.memberCount} {item.memberCount === 1 ? "member" : "members"}
                      {server === null ? "" : ` · ${item.domain}`}
                    </div>
                    {notes[item.id] && (
                      <div className="error-text" role="alert">
                        {notes[item.id]}
                      </div>
                    )}
                  </div>
                  {joined.has(item.id) ? (
                    <Link className="btn btn-secondary" to={`/communities/${item.id}`}>
                      Open
                    </Link>
                  ) : (
                    <Button busy={busy === item.id} aria-label={`Join ${item.name}`} onClick={() => void join(item)}>
                      Join
                    </Button>
                  )}
                </div>
              );
            })}

          {results.kind === "people" &&
            results.items.map((person) => {
              const identity = `@${person.username}:${person.domain}`;
              const isFriend = friendIdentities.has(identity.toLowerCase());
              return (
                <div key={person.id} className="friend-request-row browse-row">
                  <Avatar user={person} />
                  <div className="grow">
                    <div className="browse-name">{person.displayName}</div>
                    <div className="hint">{identity}</div>
                    {person.bio && <div className="hint browse-description">{person.bio}</div>}
                    {notes[person.id] && (
                      <div className={notes[person.id] === "Friend request sent." ? "hint" : "error-text"} role="status">
                        {notes[person.id]}
                      </div>
                    )}
                  </div>
                  {isFriend ? (
                    <span className="hint">Friends</span>
                  ) : (
                    <Button
                      variant="secondary"
                      busy={busy === person.id}
                      disabled={notes[person.id] === "Friend request sent."}
                      aria-label={`Add ${person.displayName} as a friend`}
                      onClick={() => void addFriend(person)}
                    >
                      Add friend
                    </Button>
                  )}
                </div>
              );
            })}

          {load.status === "ready" && nextCursor && (
            <div style={{ textAlign: "center" }}>
              <Button variant="secondary" busy={loadingMore} onClick={() => void loadMore()}>
                Load more
              </Button>
            </div>
          )}
        </Tabs>
      </div>
    </>
  );
}
