import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import * as api from "../api";
import type { Emoticon, Message } from "../api";
import { useAuth } from "../context/AuthContext";
import { useWs } from "../context/WsContext";
import { useAppData } from "../context/AppDataContext";
import { managementAccess } from "../lib/permissions";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import CommunitySettingsModal from "../components/CommunitySettingsModal";
import ConfirmModal from "../components/ConfirmModal";
import ChannelTopic from "../components/ChannelTopic";
import Button from "../components/Button";

export default function CommunityPage() {
  const { communityId, channelId } = useParams<{ communityId: string; channelId?: string }>();
  const { user } = useAuth();
  const { subscribe } = useWs();
  const { communities, communitiesLoaded, refreshCommunities } = useAppData();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [emoticons, setEmoticons] = useState<Emoticon[]>([]);
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const community = communities.find((c) => c.id === communityId);
  const channel = community?.channels.find((c) => c.id === channelId) ?? community?.channels[0];
  const channelIdRef = useRef(channel?.id);
  channelIdRef.current = channel?.id;

  useEffect(() => {
    if (!channel) return;
    setLoadingOlder(false);
    api.listChannelMessages(channel.id).then((page) => {
      setMessages(page);
      setHasMore(page.length >= api.MESSAGE_PAGE_SIZE);
    });
    api.markChannelRead(channel.id).then(refreshCommunities);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.id]);

  useEffect(() => {
    api.listEmoticons().then((r) => setEmoticons([...r.personal, ...r.saved, ...r.community]));
  }, [communityId]);

  useEffect(() => {
    if (!channel) return;
    const unsubs = [
      subscribe("message:created", (payload: { message: Message; channelId?: string }) => {
        if (payload.channelId !== channel.id) return;
        setMessages((prev) => (prev.find((m) => m.id === payload.message.id) ? prev : [...prev, payload.message]));
        // the channel is open right now, so this new message shouldn't count as unread
        void api.markChannelRead(channel.id).then(refreshCommunities);
      }),
      subscribe("message:edited", (payload: { message: Message; channelId?: string }) => {
        if (payload.channelId !== channel.id) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.message.id ? payload.message : m)));
      }),
      subscribe("message:deleted", (payload: { messageId: string; channelId?: string }) => {
        if (payload.channelId !== channel.id) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, content: null, deletedAt: new Date().toISOString() } : m)));
      }),
      subscribe("message:reaction_added", (payload: { messageId: string; reactions: Message["reactions"]; channelId?: string }) => {
        if (payload.channelId !== channel.id) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, reactions: payload.reactions } : m)));
      }),
      subscribe("message:reaction_removed", (payload: { messageId: string; reactions: Message["reactions"]; channelId?: string }) => {
        if (payload.channelId !== channel.id) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, reactions: payload.reactions } : m)));
      }),
      subscribe("typing", (payload: { channelId?: string; userId: string }) => {
        if (payload.channelId !== channel.id) return;
        setTypingUserId(payload.userId);
        setTimeout(() => setTypingUserId((cur) => (cur === payload.userId ? null : cur)), 3000);
      }),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.id, subscribe]);

  // Loaded, and this community isn't in the list: it was deleted, or we were removed from it, while we
  // were looking at it. Leave rather than sit on "Loading…" for ever.
  if (communitiesLoaded && !community) return <Navigate to="/friends" replace />;
  if (!community || !user) return <div className="empty-state">Loading…</div>;
  if (!channel) return <div className="empty-state">This community has no channels yet.</div>;
  // No channel in the URL, or one that no longer exists (e.g. it was just
  // deleted) - land on a real channel rather than leaving a stale URL.
  if (!channelId || !community.channels.some((c) => c.id === channelId)) {
    return <Navigate to={`/communities/${community.id}/${channel.id}`} replace />;
  }

  const typingMember = community.members.find((m) => m.id === typingUserId);

  async function handleSend(content: string, _attachments?: any[]) {
    const message = await api.sendChannelMessage(channel!.id, content);
    // A federated proxy send can race its own WS relay echo back from the
    // home server (see relayToRemoteDomains) - same dedup-by-id guard the
    // message:created subscriber above already uses.
    setMessages((prev) => (prev.find((m) => m.id === message.id) ? prev : [...prev, message]));
  }

  async function handleLoadOlder() {
    const oldest = messages[0];
    if (!oldest || loadingOlder) return;
    const requestedFor = channel!.id;
    setLoadingOlder(true);
    try {
      const page = await api.listChannelMessages(requestedFor, oldest.id);
      if (channelIdRef.current !== requestedFor) return; // switched channels mid-request
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...page.filter((m) => !seen.has(m.id)), ...prev];
      });
      setHasMore(page.length >= api.MESSAGE_PAGE_SIZE);
    } catch {
      // leave hasMore alone so the button stays and can be retried
    } finally {
      setLoadingOlder(false);
    }
  }

  async function handleReact(messageId: string, emoji: string, alreadyReacted: boolean) {
    const result = alreadyReacted ? await api.removeReaction(messageId, emoji) : await api.addReaction(messageId, emoji);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? result.message : m)));
  }

  async function handleEdit(messageId: string, content: string) {
    const result = await api.editMessage(messageId, content);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? result.message : m)));
  }

  async function handleDelete(messageId: string) {
    await api.deleteMessage(messageId);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content: null, deletedAt: new Date().toISOString() } : m)));
  }

  const isOwner = community.owner.id === user.id;
  // The owner, or a member whose roles grant some management permission.
  const access = managementAccess(community, user);

  async function handleLeave() {
    if (!community) return;
    await api.leaveCommunity(community.id);
    await refreshCommunities();
    navigate("/friends");
  }

  return (
    <>
      <div className="main-header" style={{ justifyContent: "space-between" }}>
        <span className="main-header-title">
          <span style={{ whiteSpace: "nowrap" }}>
            {community.name} · # {channel.name}
          </span>
          <ChannelTopic key={channel.id} topic={channel.topic} />
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          <Button
            onClick={() => {
              navigator.clipboard.writeText(community.id).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            variant="secondary"
            size="sm"
          >
            {copied ? "Copied!" : `Invite · ${community.members.length} members`}
          </Button>
          {access.any && (
            <Button onClick={() => setShowSettings(true)} variant="secondary" size="sm">
              Settings
            </Button>
          )}
          {!isOwner && (
            <Button onClick={() => setConfirmingLeave(true)} variant="secondary" size="sm">
              Leave
            </Button>
          )}
        </span>
      </div>
      <MessageList
        messages={messages}
        selfId={user.id}
        selfUsername={user.username}
        onReact={handleReact}
        onEdit={handleEdit}
        onDelete={handleDelete}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onLoadOlder={handleLoadOlder}
      />
      <div className="typing-indicator">{typingMember ? `${typingMember.displayName} is typing…` : ""}</div>
      <Composer
        placeholder={`Message #${channel.name}`}
        emoticons={emoticons}
        typingTarget={{ channelId: channel.id }}
        onSend={handleSend}
      />
      {showSettings && <CommunitySettingsModal community={community} viewer={user} onClose={() => setShowSettings(false)} />}
      {confirmingLeave && (
        <ConfirmModal
          title="Leave community"
          message={`Leave ${community.name}? You can rejoin later if you still have its community ID.`}
          confirmLabel="Leave"
          danger
          onConfirm={handleLeave}
          onClose={() => setConfirmingLeave(false)}
        />
      )}
    </>
  );
}
