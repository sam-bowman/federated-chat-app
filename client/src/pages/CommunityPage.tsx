import NotificationBell from "../components/NotificationBell";
import { useReportActiveChat } from "../lib/activeChat";
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import * as api from "../api";
import type { Message, ReactionChoice } from "../api";
import { useAuth } from "../context/AuthContext";
import { useWs } from "../context/WsContext";
import { useAppData } from "../context/AppDataContext";
import { managementAccess } from "../lib/permissions";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import { NO_EMOTICONS, type EmoticonSets } from "../lib/emoticonSets";
import CommunitySettingsModal from "../components/CommunitySettingsModal";
import ConfirmModal from "../components/ConfirmModal";
import ChannelTopic from "../components/ChannelTopic";
import Button from "../components/Button";
import InviteModal from "../components/InviteModal";
import PrivateServerNotice from "../components/PrivateServerNotice";
import { PREFETCH_KEYS, takePrefetched } from "../lib/bootPrefetch";
import { useMessageHistory } from "../lib/useMessageHistory";
import { domainOf } from "../lib/permissions";

export default function CommunityPage() {
  const { communityId, channelId } = useParams<{ communityId: string; channelId?: string }>();
  const { user } = useAuth();
  const { subscribe } = useWs();
  const { communities, communitiesLoaded, refreshCommunities } = useAppData();
  const navigate = useNavigate();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [emoticons, setEmoticons] = useState<EmoticonSets>(NO_EMOTICONS);
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const community = communities.find((c) => c.id === communityId);
  // A voice channel has no messages: it is never the page, and a community's first channel for this purpose is its first text one.
  const textChannels = community?.channels.filter((c) => c.type !== "VOICE");
  const channel = textChannels?.find((c) => c.id === channelId) ?? textChannels?.[0];
  // A message for the channel you are looking at makes no sound and no notification.
  useReportActiveChat(channel ? { channelId: channel.id, communityId: community?.id } : null);
  const channelIdRef = useRef(channel?.id);
  channelIdRef.current = channel?.id;
  // The channel's messages: never another channel's, and a channel looked at before opens at once (lib/useMessageHistory.ts).
  const { messages, hasMore, loaded, setMessages, setHasMore, noteArrival } = useMessageHistory(user?.id, channel?.id, (id) => takePrefetched<Message[]>(PREFETCH_KEYS.channelMessages(id)) ?? api.listChannelMessages(id));

  useEffect(() => {
    if (!channel) return;
    setLoadingOlder(false);
    setTypingUserId(null);
    // Marking it read changes what the lists show only when it was unread, so the communities are fetched again only then.
    const wasUnread = channel.unread === true;
    api.markChannelRead(channel.id).then(() => (wasUnread ? refreshCommunities() : undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.id]);

  useEffect(() => {
    api.listEmoticons().then((r) => setEmoticons({ personal: r.personal, saved: r.saved, community: r.community }));
  }, [communityId]);

  useEffect(() => {
    if (!channel) return;
    const unsubs = [
      subscribe("message:created", (payload: { message: Message; channelId?: string }) => {
        if (payload.channelId !== channel.id) return;
        setMessages((prev) => (prev.find((m) => m.id === payload.message.id) ? prev : [...prev, payload.message]));
        noteArrival(payload.message);
        // the channel is open right now, so this new message shouldn't count as unread
        void api.markChannelRead(channel.id).then(refreshCommunities);
      }),
      subscribe("message:edited", (payload: { message: Message; channelId?: string }) => {
        if (payload.channelId !== channel.id) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.message.id ? payload.message : m)));
      }),
      // Someone deleted their account: what they wrote is gone, wherever it is shown.
      subscribe("user:deleted", (payload: { userId: string }) => {
        setMessages((prev) => prev.filter((m) => m.sender.id !== payload.userId));
      }),
      subscribe("message:embeds", (payload: { messageId: string; embeds: Message["embeds"]; channelId?: string }) => {
        if (payload.channelId !== channel.id) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, embeds: payload.embeds } : m)));
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
  if (!channel) return <div className="empty-state">This community has no text channels yet.</div>;
  // No channel in the URL, or one that no longer exists (e.g. it was just
  // deleted) - land on a real channel rather than leaving a stale URL.
  if (!channelId || channel.id !== channelId) {
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

  async function handleReact(messageId: string, choice: ReactionChoice, alreadyReacted: boolean) {
    const result = alreadyReacted ? await api.removeReaction(messageId, choice) : await api.addReaction(messageId, choice);
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

  async function handleRemovePreviews(messageId: string) {
    await api.removeLinkPreviews(messageId);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, embeds: [] } : m)));
  }

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
          <span style={{ whiteSpace: "nowrap" }} title={`${community.name} · # ${channel.name}`}>
            {community.name} · # {channel.name}
          </span>
          <ChannelTopic key={channel.id} topic={channel.topic} />
        </span>
        <span style={{ display: "flex", gap: "0.5rem" }}>
          <NotificationBell
            target={{ kind: "channel", id: channel.id, name: channel.name, communityId: community.id, communityName: community.name }}
          />
          <Button onClick={() => setInviting(true)} variant="secondary" size="sm">
            {`Invite · ${community.members.length} members`}
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
      <PrivateServerNotice show={!!community.homeserverDomain && community.homeserverDomain.toLowerCase() !== domainOf(user.identity)}>
        This community is on another server, and this server doesn't connect to other servers right now, so you can read what is here
        but not send anything to it.
      </PrivateServerNotice>
      <MessageList
        messages={messages}
        selfId={user.id}
        selfUsername={user.username}
        onReact={handleReact}
        emoticons={emoticons}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onRemovePreviews={community.homeserverDomain && community.homeserverDomain.toLowerCase() !== domainOf(user.identity) ? undefined : handleRemovePreviews}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onLoadOlder={handleLoadOlder}
        loading={!loaded}
        communityId={community.id}
      />
      <div className="typing-indicator">{typingMember ? `${typingMember.displayName} is typing…` : ""}</div>
      <Composer
        placeholder={`Message #${channel.name}`}
        emoticons={emoticons}
        communityId={community.id}
        typingTarget={{ channelId: channel.id }}
        onSend={handleSend}
      />
      {inviting && <InviteModal community={community} viewer={user} onClose={() => setInviting(false)} />}
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
