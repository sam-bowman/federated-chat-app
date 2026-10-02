import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import * as api from "../api";
import type { Emoticon, Message } from "../api";
import { useAuth } from "../context/AuthContext";
import { useWs } from "../context/WsContext";
import { useAppData } from "../context/AppDataContext";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import CommunitySettingsModal from "../components/CommunitySettingsModal";
import ConfirmModal from "../components/ConfirmModal";

export default function CommunityPage() {
  const { communityId, channelId } = useParams<{ communityId: string; channelId?: string }>();
  const { user } = useAuth();
  const { subscribe } = useWs();
  const { communities, refreshCommunities } = useAppData();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [emoticons, setEmoticons] = useState<Emoticon[]>([]);
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const community = communities.find((c) => c.id === communityId);
  const channel = community?.channels.find((c) => c.id === channelId) ?? community?.channels[0];

  useEffect(() => {
    if (!channel) return;
    api.listChannelMessages(channel.id).then(setMessages);
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
      }),
      subscribe("message:edited", (payload: { message: Message }) => {
        setMessages((prev) => prev.map((m) => (m.id === payload.message.id ? payload.message : m)));
      }),
      subscribe("message:deleted", (payload: { messageId: string }) => {
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, content: null, deletedAt: new Date().toISOString() } : m)));
      }),
      subscribe("message:reaction_added", (payload: { messageId: string; reactions: Message["reactions"] }) => {
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, reactions: payload.reactions } : m)));
      }),
      subscribe("message:reaction_removed", (payload: { messageId: string; reactions: Message["reactions"] }) => {
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

  if (!community || !user) return <div className="empty-state">Loading…</div>;
  if (!channel) return <div className="empty-state">This community has no channels yet.</div>;
  if (!channelId) return <Navigate to={`/communities/${community.id}/${channel.id}`} replace />;

  const typingMember = community.members.find((m) => m.id === typingUserId);

  async function handleSend(content: string, _attachments?: any[]) {
    const message = await api.sendChannelMessage(channel!.id, content);
    setMessages((prev) => [...prev, message]);
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

  async function handleLeave() {
    if (!community) return;
    await api.leaveCommunity(community.id);
    await refreshCommunities();
    navigate("/friends");
  }

  return (
    <>
      <div className="main-header" style={{ justifyContent: "space-between" }}>
        <span>
          {community.name} · # {channel.name}
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          <button
            className="btn-secondary"
            style={{ borderRadius: 6, fontSize: 12 }}
            onClick={() => {
              navigator.clipboard.writeText(community.id).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied!" : `Invite · ${community.members.length} members`}
          </button>
          {isOwner && (
            <button className="btn-secondary" style={{ borderRadius: 6, fontSize: 12 }} onClick={() => setShowSettings(true)}>
              Settings
            </button>
          )}
          {!isOwner && (
            <button className="btn-secondary" style={{ borderRadius: 6, fontSize: 12 }} onClick={() => setConfirmingLeave(true)}>
              Leave
            </button>
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
      />
      <div className="typing-indicator">{typingMember ? `${typingMember.displayName} is typing…` : ""}</div>
      <Composer
        placeholder={`Message #${channel.name}`}
        emoticons={emoticons}
        typingTarget={{ channelId: channel.id }}
        onSend={handleSend}
      />
      {showSettings && <CommunitySettingsModal community={community} onClose={() => setShowSettings(false)} />}
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
