import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import * as api from "../api";
import type { Emoticon, Message } from "../api";
import { useAuth } from "../context/AuthContext";
import { useWs } from "../context/WsContext";
import { useAppData } from "../context/AppDataContext";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import PresenceDot from "../components/PresenceDot";

export default function ConversationPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { user } = useAuth();
  const { subscribe } = useWs();
  const { conversations } = useAppData();
  const [messages, setMessages] = useState<Message[]>([]);
  const [emoticons, setEmoticons] = useState<Emoticon[]>([]);
  const [typingUserId, setTypingUserId] = useState<string | null>(null);

  const conversation = conversations.find((c) => c.id === conversationId);
  const other = conversation?.members.find((m) => m.id !== user?.id);

  useEffect(() => {
    if (!conversationId) return;
    api.listMessages(conversationId).then(setMessages);
  }, [conversationId]);

  useEffect(() => {
    api.listEmoticons().then((r) => setEmoticons([...r.personal, ...r.saved, ...r.community]));
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    const unsubs = [
      subscribe("message:created", (payload: { message: Message }) => {
        if (messages.find((m) => m.id === payload.message.id)) return;
        setMessages((prev) => [...prev, payload.message]);
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
      subscribe("typing", (payload: { conversationId?: string; userId: string }) => {
        if (payload.conversationId !== conversationId) return;
        setTypingUserId(payload.userId);
        setTimeout(() => setTypingUserId((cur) => (cur === payload.userId ? null : cur)), 3000);
      }),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, subscribe]);

  const emoticonMap = useMemo(() => new Map(emoticons.map((e) => [e.trigger, e.imageUrl])), [emoticons]);

  if (!conversationId || !user) return null;

  async function handleSend(content: string, attachments?: any[]) {
    const message = await api.sendMessage(conversationId!, content, { attachments });
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

  return (
    <>
      <div className="main-header">
        {other && <PresenceDot status={other.presence.status} />}
        {conversation?.type === "DM" ? other?.displayName : conversation?.title ?? "Group chat"}
      </div>
      <MessageList
        messages={messages}
        selfId={user.id}
        selfUsername={user.username}
        emoticons={emoticonMap}
        onReact={handleReact}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
      <div className="typing-indicator">{typingUserId && other && typingUserId === other.id ? `${other.displayName} is typing…` : ""}</div>
      <Composer placeholder={`Message ${other?.displayName ?? ""}`} emoticons={emoticons} typingTarget={{ conversationId }} onSend={handleSend} />
    </>
  );
}
