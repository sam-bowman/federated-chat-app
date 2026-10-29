import NotificationBell from "../components/NotificationBell";
import { useReportActiveChat } from "../lib/activeChat";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as api from "../api";
import type { Message, ReactionChoice } from "../api";
import { useAuth } from "../context/AuthContext";
import { useWs } from "../context/WsContext";
import { useAppData } from "../context/AppDataContext";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import { NO_EMOTICONS, type EmoticonSets } from "../lib/emoticonSets";
import PresenceDot from "../components/PresenceDot";
import ConfirmModal from "../components/ConfirmModal";
import Button from "../components/Button";
import UserLink from "../components/UserLink";
import PrivateServerNotice from "../components/PrivateServerNotice";
import { ConversationCallButton, ConversationCallPeople } from "../components/ConversationCall";
import { PREFETCH_KEYS, takePrefetched } from "../lib/bootPrefetch";
import { useMessageHistory } from "../lib/useMessageHistory";
import { isOnAnotherServer } from "../lib/federation";

export default function ConversationPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { user } = useAuth();
  const { subscribe } = useWs();
  const { conversations, refreshConversations } = useAppData();
  const navigate = useNavigate();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [emoticons, setEmoticons] = useState<EmoticonSets>(NO_EMOTICONS);
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const conversation = conversations.find((c) => c.id === conversationId);
  const other = conversation?.members.find((m) => m.id !== user?.id);
  // A message for the conversation you are looking at makes no sound and no notification.
  useReportActiveChat(conversationId ? { conversationId } : null);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  // The conversation's messages: never another one's, and one looked at before opens at once (lib/useMessageHistory.ts).
  const { messages, hasMore, loaded, setMessages, setHasMore, noteArrival } = useMessageHistory(user?.id, conversationId, (id) => takePrefetched<Message[]>(PREFETCH_KEYS.conversationMessages(id)) ?? api.listMessages(id));

  useEffect(() => {
    if (!conversationId) return;
    setLoadingOlder(false);
    setTypingUserId(null);
    // Marking it read changes what the lists show only when it was unread, so the conversations are fetched again only then.
    const wasUnread = conversation?.unread === true;
    api.markConversationRead(conversationId).then(() => (wasUnread ? refreshConversations() : undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    api.listEmoticons().then((r) => setEmoticons({ personal: r.personal, saved: r.saved, community: r.community }));
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    const unsubs = [
      subscribe("message:created", (payload: { message: Message; conversationId?: string }) => {
        if (payload.conversationId !== conversationId) return;
        // Decided inside the updater, against the messages as they are NOW: this handler is subscribed once per
        // conversation, so a `messages` read here would be the list as it was when the page opened (empty), and
        // a message the history had already loaded would be drawn a second time.
        setMessages((prev) => (prev.some((m) => m.id === payload.message.id) ? prev : [...prev, payload.message]));
        noteArrival(payload.message);
        // the chat is open right now, so this new message shouldn't count as unread
        void api.markConversationRead(conversationId).then(refreshConversations);
      }),
      subscribe("message:edited", (payload: { message: Message; conversationId?: string }) => {
        if (payload.conversationId !== conversationId) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.message.id ? payload.message : m)));
      }),
      // Someone deleted their account: what they wrote is gone, wherever it is shown.
      subscribe("user:deleted", (payload: { userId: string }) => {
        setMessages((prev) => prev.filter((m) => m.sender.id !== payload.userId));
      }),
      subscribe("message:embeds", (payload: { messageId: string; embeds: Message["embeds"]; conversationId?: string }) => {
        if (payload.conversationId !== conversationId) return;
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, embeds: payload.embeds } : m)));
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

  async function handleRemovePreviews(messageId: string) {
    await api.removeLinkPreviews(messageId);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, embeds: [] } : m)));
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
        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
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
        <span style={{ display: "flex", gap: "0.5rem" }}>
          {conversation && <ConversationCallButton conversation={conversation} />}
          {conversationId && (
            <NotificationBell
              target={{
                kind: "conversation",
                id: conversationId,
                name: conversation?.type === "DM" ? (other?.displayName ?? "this chat") : (conversation?.title ?? "this group"),
              }}
            />
          )}
          <Button onClick={() => setConfirmingLeave(true)} variant="secondary" size="sm">
            {conversation?.type === "DM" ? "Delete chat" : "Leave group"}
          </Button>
        </span>
      </div>
      {conversation && <ConversationCallPeople conversation={conversation} />}
      <PrivateServerNotice show={!!conversation?.members.some((m) => isOnAnotherServer(m.identity, user.identity))}>
        This server doesn't connect to other servers right now, so what you write here is kept and sent to the people on other servers
        if it connects again.
      </PrivateServerNotice>
      <MessageList
        messages={messages}
        selfId={user.id}
        selfUsername={user.username}
        onReact={handleReact}
        emoticons={emoticons}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onRemovePreviews={handleRemovePreviews}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onLoadOlder={handleLoadOlder}
        loading={!loaded}
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
