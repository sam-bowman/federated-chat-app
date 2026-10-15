import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as api from "../api";
import type { Emoticon, Message } from "../api";
import { useAuth } from "../context/AuthContext";
import { useWs } from "../context/WsContext";
import { useAppData } from "../context/AppDataContext";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import PresenceDot from "../components/PresenceDot";
import ConfirmModal from "../components/ConfirmModal";
import Button from "../components/Button";
import UserLink from "../components/UserLink";

export default function ConversationPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { user } = useAuth();
  const { subscribe } = useWs();
  const { conversations, refreshConversations } = useAppData();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [emoticons, setEmoticons] = useState<Emoticon[]>([]);
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const conversation = conversations.find((c) => c.id === conversationId);
  const other = conversation?.members.find((m) => m.id !== user?.id);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  useEffect(() => {
    if (!conversationId) return;
    setLoadingOlder(false);
    api.listMessages(conversationId).then((page) => {
      setMessages(page);
      setHasMore(page.length >= api.MESSAGE_PAGE_SIZE);
    });
    api.markConversationRead(conversationId).then(refreshConversations);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    api.listEmoticons().then((r) => setEmoticons([...r.personal, ...r.saved, ...r.community]));
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    const unsubs = [
      subscribe("message:created", (payload: { message: Message; conversationId?: string }) => {
        if (payload.conversationId !== conversationId) return;
        if (messages.find((m) => m.id === payload.message.id)) return;
        setMessages((prev) => [...prev, payload.message]);
        // the chat is open right now, so this new message shouldn't count as unread
        void api.markConversationRead(conversationId).then(refreshConversations);
      }),
      subscribe("message:edited", (payload: { message: Message; conversationId?: string }) => {
        if (payload.conversationId !== conversationId) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.message.id ? payload.message : m)));
      }),
      subscribe("message:deleted", (payload: { messageId: string; conversationId?: string }) => {
        if (payload.conversationId !== conversationId) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, content: null, deletedAt: new Date().toISOString() } : m)));
      }),
      subscribe("message:reaction_added", (payload: { messageId: string; reactions: Message["reactions"]; conversationId?: string }) => {
        if (payload.conversationId !== conversationId) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, reactions: payload.reactions } : m)));
      }),
      subscribe("message:reaction_removed", (payload: { messageId: string; reactions: Message["reactions"]; conversationId?: string }) => {
        if (payload.conversationId !== conversationId) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, reactions: payload.reactions } : m)));
      }),
      subscribe("typing", (payload: { conversationId?: string; userId: string }) => {
        if (payload.conversationId !== conversationId) return;
        setTypingUserId(payload.userId);
        setTimeout(() => setTypingUserId((cur) => (cur === payload.userId ? null : cur)), 3000);
      }),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, subscribe]);

  if (!conversationId || !user) return null;

  async function handleSend(content: string, attachments?: any[]) {
    const message = await api.sendMessage(conversationId!, content, { attachments });
    // Same dedup-by-id guard as the message:created subscriber above, in
    // case the WS echo of our own send (e.g. relayed back through a
    // federated group DM member) resolves before this direct response does.
    setMessages((prev) => (prev.find((m) => m.id === message.id) ? prev : [...prev, message]));
  }

  async function handleLoadOlder() {
    const oldest = messages[0];
    if (!oldest || loadingOlder) return;
    const requestedFor = conversationId!;
    setLoadingOlder(true);
    try {
      const page = await api.listMessages(requestedFor, oldest.id);
      if (conversationIdRef.current !== requestedFor) return; // switched conversations mid-request
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

  async function handleLeave() {
    if (!conversationId) return;
    await api.leaveConversation(conversationId);
    await refreshConversations();
    navigate("/friends");
  }

  return (
    <>
      <div className="main-header" style={{ justifyContent: "space-between" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {other && <PresenceDot status={other.presence.status} />}
          {conversation?.type === "DM" ? (
            other ? (
              <UserLink user={other}>
                <span className="user-link-name">{other.displayName}</span>
              </UserLink>
            ) : (
              "(left)"
            )
          ) : (
            conversation?.title ?? "Group chat"
          )}
        </span>
        <Button onClick={() => setConfirmingLeave(true)} variant="secondary" size="sm">
          {conversation?.type === "DM" ? "Delete chat" : "Leave group"}
        </Button>
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
      <div className="typing-indicator">{typingUserId && other && typingUserId === other.id ? `${other.displayName} is typing…` : ""}</div>
      <Composer
        placeholder={`Message ${other?.displayName ?? "(left)"}`}
        emoticons={emoticons}
        typingTarget={{ conversationId }}
        onSend={handleSend}
      />
      {confirmingLeave && (
        <ConfirmModal
          title={conversation?.type === "DM" ? "Delete chat" : "Leave group"}
          message={`Delete this conversation with ${other?.displayName ?? "this chat"}? It'll disappear from your chat list - the other member(s) keep their copy.`}
          confirmLabel={conversation?.type === "DM" ? "Delete" : "Leave"}
          danger
          onConfirm={handleLeave}
          onClose={() => setConfirmingLeave(false)}
        />
      )}
    </>
  );
}
