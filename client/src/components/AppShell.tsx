import { useEffect, useRef, useState } from "react";
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
import UpdateBanner from "./UpdateBanner";
import DeletionCancelledNotice from "./DeletionCancelledNotice";
import VoiceChannelRow from "./VoiceChannelRow";
import VoicePanel from "./VoicePanel";
import IncomingCalls from "./IncomingCalls";
import SidebarResizer from "./SidebarResizer";
import { appearanceForShortcut, getAppearance, isDesktopApp, setAppearance } from "../lib/appearance";
import { initialPane, paneAfterNavigation, useNarrow, useVisibleHeight, type Pane } from "../lib/mobilePane";
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

  // On a phone one pane is shown at a time: the lists (communities, channels, chats) or the page. See lib/mobilePane.ts.
  const narrow = useNarrow();
  useVisibleHeight(narrow);
  const [pane, setPane] = useState<Pane>(() => initialPane(location.pathname));
  const previousPath = useRef(location.pathname);
  /** When the person last tapped something in the rail, which has already chosen the pane (so the address change must not). */
  const choseNavAt = useRef(0);
  // A window that becomes narrow starts from where the person is, not from whatever pane was set while it was wide.
  const wasNarrow = useRef(narrow);
  useEffect(() => {
    if (narrow && !wasNarrow.current) setPane(initialPane(location.pathname));
    wasNarrow.current = narrow;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);
  useEffect(() => {
    const previous = previousPath.current;
    previousPath.current = location.pathname;
    if (previous === location.pathname) return;
    if (Date.now() - choseNavAt.current < 500) return;
    setPane(paneAfterNavigation(previous, location.pathname));
  }, [location.pathname]);

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
  /** Tapping a channel, chat or page in a list opens it, on a phone. (A voice channel is a button: it joins and stays on the list.) */
  const showPageOnLinkClick = (event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("a")) setPane("content");
  };

  return (
    <div className="app-shell" data-narrow={narrow || undefined} data-pane={narrow ? pane : undefined} style={{ "--sidebar-width": `${sidebarWidth}rem` } as React.CSSProperties}>
      <IncomingCalls />
      <CommunityRail
        communities={communities}
        activeCommunityId={communityId}
        atHome={!inCommunityView && !atBrowse}
        atBrowse={atBrowse}
        hasUnreadConversation={conversations.some((c) => c.unread)}
        pendingRequestCount={incomingRequests.length}
        onCreateCommunity={() => setShowNewCommunity(true)}
        onClickCapture={(event) => {
          // Home and a community show their list; Browse is a page.
          const link = (event.target as HTMLElement).closest("a");
          if (!link) return;
          choseNavAt.current = Date.now();
          setPane(link.getAttribute("href")?.startsWith("/browse") ? "content" : "nav");
        }}
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
            <div className="sidebar-list" onClickCapture={showPageOnLinkClick}>
              {activeCommunity.channels.map((ch) =>
                ch.type === "VOICE" ? (
                  <VoiceChannelRow key={ch.id} channel={ch} community={activeCommunity} />
                ) : (
                <NavLink
                  key={ch.id}
                  to={`/communities/${activeCommunity.id}/${ch.id}`}
                  title={ch.topic?.trim() || undefined}
                  className={({ isActive }) => `sidebar-row ${isActive ? "active" : ""}`}
                >
                  <span style={{ flex: 1, fontWeight: ch.unread ? 700 : 400 }}># {ch.name}</span>
                  {ch.unread && <span className="presence-dot ONLINE" style={{ border: "none" }} title="Unread" />}
                </NavLink>
                )
              )}
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
            <div className="sidebar-list" onClickCapture={showPageOnLinkClick}>
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

        {/* One call panel at a time: on a phone reading a page it is shown above the page instead. */}
        {!(narrow && pane === "content") && <VoicePanel />}

        <AccountFooter
          user={user}
          onOpenSettings={() => {
            navigate("/settings");
            setPane("content");
          }}
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
        {narrow && pane === "content" && (
          <div className="mobile-back">
            <Button variant="ghost" size="sm" onClick={() => setPane("nav")}>
              ‹ {inCommunityView && activeCommunity ? activeCommunity.name : "Chats"}
            </Button>
          </div>
        )}
        {/* The sidebar, where the call controls live, is not shown while reading a page: keep them in reach. */}
        {narrow && pane === "content" && (
          <div className="mobile-call">
            <VoicePanel />
          </div>
        )}
        <Outlet />
      </main>

      <UpdateBanner />
      <DeletionCancelledNotice />

      {showNewCommunity && <NewCommunityModal onClose={() => setShowNewCommunity(false)} />}
      {showNewConversation && <NewConversationModal onClose={() => setShowNewConversation(false)} />}
      {showNewChannel && activeCommunity && (
        <NewChannelModal communityId={activeCommunity.id} onClose={() => setShowNewChannel(false)} />
      )}
    </div>
  );
}
