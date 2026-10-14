import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useAppData } from "../context/AppDataContext";
import { managementAccess } from "../lib/permissions";
import * as api from "../api";
import AccountFooter from "./AccountFooter";
import Avatar from "./Avatar";
import CommunityRail from "./CommunityRail";
import PresenceDot from "./PresenceDot";
import NewCommunityModal from "./NewCommunityModal";
import NewConversationModal from "./NewConversationModal";
import NewChannelModal from "./NewChannelModal";

// null when the other party has left - a DM you deleted-for-yourself-then-
// reopened-as-sender-of-nothing, or (more commonly) the other side left a DM
// that's still in your list because YOU haven't deleted it. Don't fall back
// to showing yourself as "the other member".
function otherMember(conversation: api.Conversation, selfId: string) {
  return conversation.members.find((m) => m.id !== selfId) ?? null;
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const { conversations, communities, incomingRequests } = useAppData();
  const { communityId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [showNewCommunity, setShowNewCommunity] = useState(false);
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);

  if (!user) return null;

  const activeCommunity = communities.find((c) => c.id === communityId);
  const inCommunityView = location.pathname.startsWith("/communities/");

  return (
    <div className="app-shell">
      <CommunityRail
        communities={communities}
        activeCommunityId={communityId}
        atHome={!inCommunityView}
        hasUnreadConversation={conversations.some((c) => c.unread)}
        pendingRequestCount={incomingRequests.length}
        onCreateCommunity={() => setShowNewCommunity(true)}
      />

      <aside className="sidebar">
        {inCommunityView && activeCommunity ? (
          <>
            <div className="sidebar-header" style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{activeCommunity.name}</span>
              {managementAccess(activeCommunity, user).channels && (
                <button
                  className="btn-secondary"
                  style={{ borderRadius: 6, padding: "2px 8px" }}
                  onClick={() => setShowNewChannel(true)}
                  title="Create channel"
                >
                  +
                </button>
              )}
            </div>
            <div className="sidebar-list">
              {activeCommunity.channels.map((ch) => (
                <NavLink
                  key={ch.id}
                  to={`/communities/${activeCommunity.id}/${ch.id}`}
                  className={({ isActive }) => `sidebar-row ${isActive ? "active" : ""}`}
                >
                  <span style={{ flex: 1, fontWeight: ch.unread ? 700 : 400 }}># {ch.name}</span>
                  {ch.unread && <span className="presence-dot ONLINE" style={{ border: "none" }} title="Unread" />}
                </NavLink>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="sidebar-header" style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Chats</span>
              <button className="btn-secondary" style={{ borderRadius: 6, padding: "2px 8px" }} onClick={() => setShowNewConversation(true)}>
                +
              </button>
            </div>
            <div className="sidebar-list">
              <NavLink to="/friends" className={({ isActive }) => `sidebar-row ${isActive ? "active" : ""}`}>
                👥 Friends
                {incomingRequests.length > 0 && <span className="badge">{incomingRequests.length}</span>}
              </NavLink>
              <NavLink to="/emoticons" className={({ isActive }) => `sidebar-row ${isActive ? "active" : ""}`}>
                😊 Emoticons
              </NavLink>
              <div style={{ margin: "10px 10px 4px", color: "var(--text-dim)", fontSize: 12, fontWeight: 700 }}>
                DIRECT MESSAGES
              </div>
              {conversations.map((c) => {
                const other = otherMember(c, user.id);
                const title = c.type === "DM" ? (other?.displayName ?? "(left)") : c.title ?? "Group";
                return (
                  <NavLink key={c.id} to={`/dm/${c.id}`} className={({ isActive }) => `sidebar-row ${isActive ? "active" : ""}`}>
                    {other ? <Avatar user={other} size="sm" /> : <div className="avatar sm">·</div>}
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", fontWeight: c.unread ? 700 : 400 }}>
                      {title}
                    </span>
                    {c.unread && <span className="presence-dot ONLINE" style={{ border: "none" }} title="Unread" />}
                    {c.type === "DM" && other && <PresenceDot status={other.presence.status} />}
                  </NavLink>
                );
              })}
            </div>
          </>
        )}

        <AccountFooter user={user} onOpenSettings={() => navigate("/settings")} onSignOut={logout} />
      </aside>

      <main className="main">
        <Outlet />
      </main>

      {showNewCommunity && <NewCommunityModal onClose={() => setShowNewCommunity(false)} />}
      {showNewConversation && <NewConversationModal onClose={() => setShowNewConversation(false)} />}
      {showNewChannel && activeCommunity && (
        <NewChannelModal communityId={activeCommunity.id} onClose={() => setShowNewChannel(false)} />
      )}
    </div>
  );
}
