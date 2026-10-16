import { useEffect, useState } from "react";
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
import Button from "./Button";
import SidebarResizer from "./SidebarResizer";
import { appearanceForShortcut, getAppearance, isDesktopApp, setAppearance } from "../lib/appearance";
import { SIDEBAR_DEFAULT_REM, forgetSidebarWidth, loadSidebarWidth, saveSidebarWidth } from "../lib/sidebarWidth";

// null when the other party has left - a DM you deleted-for-yourself-then-
// reopened-as-sender-of-nothing, or (more commonly) the other side left a DM
// that's still in your list because YOU haven't deleted it. Don't fall back
// to showing yourself as "the other member".
function otherMember(conversation: api.Conversation, selfId: string) {
  return conversation.members.find((m) => m.id !== selfId) ?? null;
}

export default function AppShell() {
  const { user, logout, refreshUser } = useAuth();
  const { conversations, communities, incomingRequests } = useAppData();
  const { communityId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [showNewCommunity, setShowNewCommunity] = useState(false);
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  // The sidebar's width: the person drags its edge, and it is remembered on this device.
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);

  // In the desktop app the browser's zoom keys may not exist, so Ctrl and + / - / 0 change the UI scale itself.
  // In a browser they stay the browser's own zoom, which must not be taken over.
  useEffect(() => {
    if (!isDesktopApp()) return;
    function onKeyDown(event: KeyboardEvent) {
      const next = appearanceForShortcut(event, getAppearance(), window.screen.width);
      if (!next) return;
      event.preventDefault();
      setAppearance(next);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!user) return null;

  const activeCommunity = communities.find((c) => c.id === communityId);
  const inCommunityView = location.pathname.startsWith("/communities/");
  const atBrowse = location.pathname === "/browse";

  return (
    <div className="app-shell" style={{ "--sidebar-width": `${sidebarWidth}rem` } as React.CSSProperties}>
      <CommunityRail
        communities={communities}
        activeCommunityId={communityId}
        atHome={!inCommunityView && !atBrowse}
        atBrowse={atBrowse}
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
                <Button
                  onClick={() => setShowNewChannel(true)}
                  title="Create channel"
                  variant="secondary"
                  size="sm"
                >
                  +
                </Button>
              )}
            </div>
            <div className="sidebar-list">
              {activeCommunity.channels.map((ch) => (
                <NavLink
                  key={ch.id}
                  to={`/communities/${activeCommunity.id}/${ch.id}`}
                  title={ch.topic?.trim() || undefined}
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
              <Button onClick={() => setShowNewConversation(true)} variant="secondary" size="sm">
                +
              </Button>
            </div>
            <div className="sidebar-list">
              <NavLink to="/friends" className={({ isActive }) => `sidebar-row ${isActive ? "active" : ""}`}>
                👥 Friends
                {incomingRequests.length > 0 && <span className="badge">{incomingRequests.length}</span>}
              </NavLink>
              <NavLink to="/emoticons" className={({ isActive }) => `sidebar-row ${isActive ? "active" : ""}`}>
                😊 Emoticons
              </NavLink>
              <div style={{ margin: "0.625rem 0.625rem 0.25rem", color: "var(--text-dim)", fontSize: "0.75rem", fontWeight: 700 }}>
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

        <AccountFooter
          user={user}
          onOpenSettings={() => navigate("/settings")}
          onSignOut={logout}
          onSetPresence={async (patch) => {
            await api.setPresence(patch);
            // The footer and Settings both read the signed-in user, so refreshing it keeps them agreeing.
            await refreshUser();
          }}
        />
      </aside>

      <SidebarResizer
        width={sidebarWidth}
        onChange={setSidebarWidth}
        onCommit={saveSidebarWidth}
        onReset={() => {
          forgetSidebarWidth();
          setSidebarWidth(SIDEBAR_DEFAULT_REM);
        }}
      />

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
