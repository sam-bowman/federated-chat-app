import { useEffect, useRef, useState } from "react";
import type { Message } from "../api";
import { mediaUrl } from "../api";
import Avatar from "./Avatar";
import MessageContent from "./MessageContent";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢"];

interface Props {
  messages: Message[];
  selfId: string;
  selfUsername: string;
  emoticons: Map<string, string>;
  onReact: (messageId: string, emoji: string, alreadyReacted: boolean) => void;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onDelete: (messageId: string) => void;
}

export default function MessageList({ messages, selfId, selfUsername, emoticons, onReact, onEdit, onDelete }: Props) {
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
      {messages.map((m) => {
        const own = m.sender.id === selfId;
        const isEditing = editingId === m.id;
        return (
          <div key={m.id} className={`message ${own ? "own" : ""}`}>
            <Avatar user={m.sender} />
            <div>
              <div className="message-content">
                {!own && <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 2 }}>{m.sender.displayName}</div>}
                {m.replyTo && (
                  <div className="hint" style={{ marginBottom: 4 }}>
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
                  <div>
                    <MessageContent content={m.content ?? ""} emoticons={emoticons} />
                  </div>
                )}

                {m.attachments.map((a) =>
                  a.contentType.startsWith("image/") ? (
                    <img key={a.id} src={mediaUrl(a.url)} alt={a.filename} style={{ maxWidth: 260, borderRadius: 8, marginTop: 6, display: "block" }} />
                  ) : (
                    <a key={a.id} href={mediaUrl(a.url)} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 6 }}>
                      📎 {a.filename}
                    </a>
                  )
                )}
              </div>

              <div className="message-meta" style={{ display: "flex", gap: 8, justifyContent: own ? "flex-end" : "flex-start" }}>
                <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                {m.editedAt && <span>(edited)</span>}
                {!m.deletedAt && (
                  <>
                    {QUICK_REACTIONS.map((emoji) => (
                      <span
                        key={emoji}
                        style={{ cursor: "pointer" }}
                        onClick={() =>
                          onReact(m.id, emoji, m.reactions.some((r) => r.emoji === emoji && r.users.includes(selfUsername)))
                        }
                      >
                        {emoji}
                      </span>
                    ))}
                    {own && (
                      <>
                        <span style={{ cursor: "pointer" }} onClick={() => { setEditingId(m.id); setEditValue(m.content ?? ""); }}>
                          edit
                        </span>
                        <span style={{ cursor: "pointer" }} onClick={() => onDelete(m.id)}>
                          delete
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>

              {m.reactions.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 2, justifyContent: own ? "flex-end" : "flex-start" }}>
                  {m.reactions.map((r) => (
                    <span
                      key={r.emoji}
                      className="hint"
                      style={{ background: "var(--bg-2)", borderRadius: 10, padding: "1px 7px", cursor: "pointer" }}
                      onClick={() => onReact(m.id, r.emoji, r.users.includes(selfUsername))}
                      title={r.users.join(", ")}
                    >
                      {r.emoji} {r.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
