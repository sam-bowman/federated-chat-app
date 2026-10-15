import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import { useAppData } from "../context/AppDataContext";
import Avatar from "../components/Avatar";
import PresenceDot from "../components/PresenceDot";
import { noAutofill } from "../lib/noAutofill";
import Button from "../components/Button";
import Tabs from "../components/Tabs";

type Tab = "friends" | "incoming" | "outgoing" | "blocked";

export default function FriendsPage() {
  const { friends, incomingRequests, refreshFriends, refreshRequests, refreshConversations } = useAppData();
  const [tab, setTab] = useState<Tab>("friends");
  const [outgoing, setOutgoing] = useState<api.FriendRequest[]>([]);
  const [blocked, setBlocked] = useState<api.PublicUser[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<api.PublicUser[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  // Whether the results list is showing, and which row the arrow keys are on (-1: none).
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState(-1);
  const searchRef = useRef<HTMLFormElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // also refetch whenever our friends list changes, since an outgoing
    // request that just got accepted should drop out of this list too
    api.listFriendRequests("outgoing").then(setOutgoing);
  }, [incomingRequests, friends]);

  useEffect(() => {
    api.listBlocked().then(setBlocked);
  }, [friends]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    // A slow answer for an older query must not land after the box was cleared or changed.
    let current = true;
    const handle = setTimeout(() => {
      api
        .searchUsers(query)
        .then((found) => current && setResults(found))
        .catch(() => current && setResults([]));
    }, 250);
    return () => {
      current = false;
      clearTimeout(handle);
    };
  }, [query]);

  // Clicking anywhere outside the search box and its results closes the list.
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (!searchRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  async function addFriend(username: string) {
    setMessage(null);
    // Whatever the outcome, this search is over: close the list so a row cannot stay stuck over the box.
    setResults([]);
    setOpen(false);
    try {
      await api.sendFriendRequest(username);
      setMessage(`Friend request sent to ${username}.`);
      setQuery("");
      setOutgoing(await api.listFriendRequests("outgoing"));
    } catch (err: any) {
      const code = err?.body?.error;
      if (code === "already_friends") {
        setMessage("You're already friends.");
        setQuery("");
      } else if (code === "request_already_pending") {
        setMessage("There is already a pending request with them: see the Incoming and Outgoing tabs.");
        setQuery("");
      } else if (code === "blocked") {
        setMessage("You can't send a request to them.");
      } else if (code === "user_not_found") {
        setMessage("No one with that name was found.");
      } else {
        setMessage("Couldn't send request.");
      }
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const showing = open && results.length > 0;
    if (e.key === "Escape" && showing) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!results.length) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i < 0 ? (step === 1 ? 0 : results.length - 1) : (i + step + results.length) % results.length));
    } else if (e.key === "Enter" && showing && active >= 0 && results[active]) {
      e.preventDefault();
      addFriend(results[active].username);
    }
  }

  async function accept(id: string) {
    await api.acceptFriendRequest(id);
    await refreshRequests();
    await refreshFriends();
  }

  async function decline(id: string) {
    await api.declineFriendRequest(id);
    await refreshRequests();
  }

  async function cancel(id: string) {
    await api.cancelFriendRequest(id);
    setOutgoing(await api.listFriendRequests("outgoing"));
  }

  async function startDm(identity: string) {
    const conversation = await api.createConversation("DM", [identity]);
    await refreshConversations();
    navigate(`/dm/${conversation.id}`);
  }

  async function remove(userId: string) {
    await api.removeFriend(userId);
    await refreshFriends();
  }

  async function block(username: string) {
    await api.blockUser(username);
    setMessage(null);
    setResults([]);
    await refreshFriends();
    await refreshRequests();
    setBlocked(await api.listBlocked());
  }

  async function unblock(userId: string) {
    await api.unblockUser(userId);
    setBlocked(await api.listBlocked());
  }

  return (
    <>
      <div className="main-header">Friends</div>
      <div className="panel">
        <form
          ref={searchRef}
          style={{ marginBottom: 20, position: "relative", display: "flex", gap: 8 }}
          // Tabbing out of the box and its buttons closes the list too (a mouse click elsewhere is handled above).
          onBlur={(e) => {
            if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
          }}
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) addFriend(query.trim());
          }}
        >
          <input {...noAutofill}
            name="friend-search"
            style={{ flex: 1 }}
            placeholder="Add a friend: alex, or @alex:theirserver.com for someone on another server…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value.toLowerCase());
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onSearchKeyDown}
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-autocomplete="list"
          />
          <Button type="submit" disabled={!query.trim()}>
            Send request
          </Button>
          {open && results.length > 0 && (
            <div className="sidebar" style={{ position: "absolute", width: "100%", zIndex: 10, border: "1px solid var(--border)", borderRadius: 8, maxHeight: 220 }}>
              {results.map((u, i) => (
                <div
                  key={u.id}
                  className="friend-request-row"
                  style={{ margin: 4, background: i === active ? "var(--bg-3)" : undefined }}
                  aria-current={i === active || undefined}
                >
                  <Avatar user={u} size="sm" />
                  <span className="grow">{u.displayName} · {u.identity}</span>
                  <Button type="button" onClick={() => addFriend(u.username)} size="sm">
                    Add
                  </Button>
                  <Button type="button" onClick={() => block(u.username)} variant="danger" size="sm">
                    Block
                  </Button>
                </div>
              ))}
            </div>
          )}
          {message && <div className="hint" style={{ marginTop: 6 }}>{message}</div>}
        </form>

        <Tabs
          label="Friends"
          value={tab}
          onChange={setTab}
          minHeight="14rem"
          tabs={[
            { id: "friends", label: `Friends (${friends.length})` },
            { id: "incoming", label: `Incoming (${incomingRequests.length})` },
            { id: "outgoing", label: `Outgoing (${outgoing.length})` },
            { id: "blocked", label: `Blocked (${blocked.length})` },
          ]}
        >
          {tab === "friends" &&
            (friends.length === 0 ? (
              <div className="empty-state">No friends yet. Search above to add one.</div>
            ) : (
              friends.map((f) => (
                <div key={f.id} className="friend-request-row">
                  <Avatar user={f} />
                  <PresenceDot status={f.presence.status} />
                  <div className="grow">
                    <div>{f.displayName}</div>
                    <div className="hint">{f.presence.customStatus ?? f.identity}</div>
                  </div>
                  <Button onClick={() => startDm(f.identity)} variant="secondary">
                    Message
                  </Button>
                  <Button onClick={() => remove(f.id)} variant="secondary">
                    Remove
                  </Button>
                  <Button onClick={() => block(f.username)} variant="danger">
                    Block
                  </Button>
                </div>
              ))
            ))}

          {tab === "incoming" &&
            (incomingRequests.length === 0 ? (
              <div className="empty-state">No incoming requests.</div>
            ) : (
              incomingRequests.map((r) => (
                <div key={r.id} className="friend-request-row">
                  <Avatar user={r.from} />
                  <div className="grow">
                    <div>{r.from.displayName}</div>
                    <div className="hint">{r.message || r.from.identity}</div>
                  </div>
                  <Button onClick={() => accept(r.id)}>
                    Accept
                  </Button>
                  <Button onClick={() => decline(r.id)} variant="secondary">
                    Decline
                  </Button>
                </div>
              ))
            ))}

          {tab === "outgoing" &&
            (outgoing.length === 0 ? (
              <div className="empty-state">No outgoing requests.</div>
            ) : (
              outgoing.map((r) => (
                <div key={r.id} className="friend-request-row">
                  <Avatar user={r.to} />
                  <div className="grow">
                    <div>{r.to.displayName}</div>
                    <div className="hint">Pending…</div>
                  </div>
                  <Button onClick={() => cancel(r.id)} variant="secondary">
                    Cancel
                  </Button>
                </div>
              ))
            ))}

          {tab === "blocked" &&
            (blocked.length === 0 ? (
              <div className="empty-state">No blocked users.</div>
            ) : (
              blocked.map((u) => (
                <div key={u.id} className="friend-request-row">
                  <Avatar user={u} />
                  <div className="grow">
                    <div>{u.displayName}</div>
                    <div className="hint">{u.identity}</div>
                  </div>
                  <Button onClick={() => unblock(u.id)} variant="secondary">
                    Unblock
                  </Button>
                </div>
              ))
            ))}
        </Tabs>
      </div>
    </>
  );
}
