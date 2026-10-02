import { Fragment, useEffect, useRef, useState } from "react";
import type { Message } from "../api";
import { mediaUrl } from "../api";
import Avatar from "./Avatar";
import MessageContent from "./MessageContent";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢"];
const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface Props {
  messages: Message[];
  selfId: string;
  selfUsername: string;
  onReact: (messageId: string, emoji: string, alreadyReacted: boolean) => void;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onDelete: (messageId: string) => void;
}

function sameDay(a: string, b: string) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function isGrouped(prev: Message | undefined, curr: Message) {
  if (!prev) return false;
  if (prev.sender.id !== curr.sender.id) return false;
  if (!sameDay(prev.createdAt, curr.createdAt)) return false;
  return new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

export default function MessageList({ messages, selfId, selfUsername, onReact, onEdit, onDelete }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  if (messages.length === 0) {
    return <div className="empty-state">No messages yet. Say hello!</div>;
  }

  return (
    <div className="message-list">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const grouped = isGrouped(prev, m);
        const own = m.sender.id === selfId;
        const isEditing = editingId === m.id;

        return (
          <Fragment key={m.id}>
            {(!prev || !sameDay(prev.createdAt, m.createdAt)) && (
              <div className="date-divider">
                <span>{formatDate(m.createdAt)}</span>
              </div>
            )}
            <div className={`message-row ${grouped ? "grouped" : ""}`}>
              <div className="message-gutter">
                {grouped ? <span className="hover-timestamp">{formatTime(m.createdAt)}</span> : <Avatar user={m.sender} />}
              </div>
              <div className="message-body">
                {!grouped && (
                  <div className="message-header">
                    <span className="message-author">{own ? "You" : m.sender.displayName}</span>
                    <span className="message-time">{formatTime(m.createdAt)}</span>
                  </div>
                )}
                {m.replyTo && (
                  <div className="hint" style={{ marginBottom: 2 }}>
                    ↪ replying to {m.replyTo.sender.displayName}
                  </div>
                )}
                {m.deletedAt ? (
                  <em className="hint">message deleted</em>
                ) : isEditing ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      await onEdit(m.id, editValue);
                      setEditingId(null);
                    }}
                    style={{ display: "flex", gap: 6 }}
                  >
                    <input value={editValue} onChange={(e) => setEditValue(e.target.value)} autoFocus />
                    <button className="btn" type="submit">
                      Save
                    </button>
                  </form>
                ) : (
                  <div className="message-text">
                    <MessageContent content={m.content ?? ""} emoticons={m.emoticons} currentUserId={selfId} />
                    {m.editedAt && <span className="message-edited">(edited)</span>}
                  </div>
                )}

                {m.attachments.map((a) =>
                  a.contentType.startsWith("image/") ? (
                    <img key={a.id} src={mediaUrl(a.url)} alt={a.filename} className="message-attachment-image" />
                  ) : (
                    <a key={a.id} href={mediaUrl(a.url)} target="_blank" rel="noreferrer" className="message-attachment-file">
                      📎 {a.filename}
                    </a>
                  )
                )}

                {m.reactions.length > 0 && (
                  <div className="reaction-row">
                    {m.reactions.map((r) => (
                      <span
                        key={r.emoji}
                        className={`reaction-pill ${r.users.includes(selfUsername) ? "mine" : ""}`}
                        onClick={() => onReact(m.id, r.emoji, r.users.includes(selfUsername))}
                        title={r.users.join(", ")}
                      >
                        {r.emoji} {r.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {!m.deletedAt && !isEditing && (
                <div className="message-actions">
                  {QUICK_REACTIONS.map((emoji) => (
                    <span
                      key={emoji}
                      className="message-action"
                      onClick={() =>
                        onReact(m.id, emoji, m.reactions.some((r) => r.emoji === emoji && r.users.includes(selfUsername)))
                      }
                    >
                      {emoji}
                    </span>
                  ))}
                  {own && (
                    <>
                      <span
                        className="message-action"
                        title="Edit"
                        onClick={() => {
                          setEditingId(m.id);
                          setEditValue(m.content ?? "");
                        }}
                      >
                        ✎
                      </span>
                      <span className="message-action" title="Delete" onClick={() => onDelete(m.id)}>
                        🗑
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
