import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api";
import { useAppData } from "../context/AppDataContext";
import Avatar from "../components/Avatar";
import PresenceDot from "../components/PresenceDot";

type Tab = "friends" | "incoming" | "outgoing" | "blocked";

export default function FriendsPage() {
  const { friends, incomingRequests, refreshFriends, refreshRequests, refreshConversations } = useAppData();
  const [tab, setTab] = useState<Tab>("friends");
  const [outgoing, setOutgoing] = useState<api.FriendRequest[]>([]);
  const [blocked, setBlocked] = useState<api.PublicUser[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<api.PublicUser[]>([]);
  const [message, setMessage] = useState<string | null>(null);
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
    const handle = setTimeout(() => {
      api.searchUsers(query).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  async function addFriend(username: string) {
    setMessage(null);
    try {
      await api.sendFriendRequest(username);
      setMessage(`Friend request sent to ${username}.`);
      setQuery("");
      setResults([]);
      setOutgoing(await api.listFriendRequests("outgoing"));
    } catch (err: any) {
      setMessage(err?.body?.error === "already_friends" ? "You're already friends." : "Couldn't send request.");
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

  async function startDm(username: string) {
    const conversation = await api.createConversation("DM", [username]);
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
        <div style={{ marginBottom: 20, position: "relative" }}>
          <input
            style={{ width: "100%" }}
            placeholder="Add a friend by username…"
            value={query}
            onChange={(e) => setQuery(e.target.value.toLowerCase())}
          />
          {results.length > 0 && (
            <div className="sidebar" style={{ position: "absolute", width: "100%", zIndex: 10, border: "1px solid var(--border)", borderRadius: 8, maxHeight: 220 }}>
              {results.map((u) => (
                <div key={u.id} className="friend-request-row" style={{ margin: 4 }}>
                  <Avatar user={u} size="sm" />
                  <span className="grow">{u.displayName} · {u.identity}</span>
                  <button className="btn" style={{ padding: "4px 10px" }} onClick={() => addFriend(u.username)}>
                    Add
                  </button>
                  <button className="btn-danger" style={{ padding: "4px 10px" }} onClick={() => block(u.username)}>
                    Block
                  </button>
                </div>
              ))}
            </div>
          )}
          {message && <div className="hint" style={{ marginTop: 6 }}>{message}</div>}
        </div>

        <div className="tabs" style={{ padding: 0, marginBottom: 10 }}>
          <div className={`tab ${tab === "friends" ? "active" : ""}`} onClick={() => setTab("friends")}>
            Friends ({friends.length})
          </div>
          <div className={`tab ${tab === "incoming" ? "active" : ""}`} onClick={() => setTab("incoming")}>
            Incoming ({incomingRequests.length})
          </div>
          <div className={`tab ${tab === "outgoing" ? "active" : ""}`} onClick={() => setTab("outgoing")}>
            Outgoing ({outgoing.length})
          </div>
          <div className={`tab ${tab === "blocked" ? "active" : ""}`} onClick={() => setTab("blocked")}>
            Blocked ({blocked.length})
          </div>
        </div>

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
                <button className="btn-secondary" style={{ borderRadius: 6 }} onClick={() => startDm(f.username)}>
                  Message
                </button>
                <button className="btn-secondary" style={{ borderRadius: 6 }} onClick={() => remove(f.id)}>
                  Remove
                </button>
                <button className="btn-danger" style={{ borderRadius: 6 }} onClick={() => block(f.username)}>
                  Block
                </button>
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
                <button className="btn" style={{ borderRadius: 6 }} onClick={() => accept(r.id)}>
                  Accept
                </button>
                <button className="btn-secondary" style={{ borderRadius: 6 }} onClick={() => decline(r.id)}>
                  Decline
                </button>
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
                <button className="btn-secondary" style={{ borderRadius: 6 }} onClick={() => cancel(r.id)}>
                  Cancel
                </button>
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
                <button className="btn-secondary" style={{ borderRadius: 6 }} onClick={() => unblock(u.id)}>
                  Unblock
                </button>
              </div>
            ))
          ))}
      </div>
    </>
  );
}
