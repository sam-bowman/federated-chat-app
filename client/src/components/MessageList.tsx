import { Fragment, useLayoutEffect, useRef, useState } from "react";
import type { Message } from "../api";
import { mediaUrl } from "../api";
import Avatar from "./Avatar";
import { ApiError } from "../api/client";
import { EMOJI_PICKER_TRIGGER_ATTR, EmojiPopover } from "./EmojiPicker";
import MessageContent from "./MessageContent";
import { noAutofill } from "../lib/noAutofill";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢"];
const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface Props {
  messages: Message[];
  selfId: string;
  selfUsername: string;
  onReact: (messageId: string, emoji: string, alreadyReacted: boolean) => void | Promise<unknown>;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onDelete: (messageId: string) => void;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
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

export default function MessageList({
  messages,
  selfId,
  selfUsername,
  onReact,
  onEdit,
  onDelete,
  hasMore,
  loadingOlder,
  onLoadOlder,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // The message whose "more reactions" picker is open, and where its button was.
  const [picker, setPicker] = useState<{ messageId: string; anchor: DOMRect } | null>(null);
  const [reactionError, setReactionError] = useState<string | null>(null);

  const firstIdRef = useRef<string | undefined>(undefined);
  const lastIdRef = useRef<string | undefined>(undefined);
  // Set when the user asks for older messages; consumed when they land.
  const prependFromHeightRef = useRef<number | null>(null);

  // Scroll to the bottom only when the *newest* message changes (a new
  // message, or a different channel/conversation entirely) - not whenever the
  // count changes, which would throw the reader to the bottom every time older
  // history is prepended. When older messages are prepended instead, grow
  // scrollTop by exactly the height that was added above, so the message they
  // were reading stays where it was.
  useLayoutEffect(() => {
    const firstId = messages[0]?.id;
    const lastId = messages[messages.length - 1]?.id;
    const list = listRef.current;
    if (list) {
      if (lastId !== lastIdRef.current) {
        bottomRef.current?.scrollIntoView({ block: "end" });
      } else if (firstId !== firstIdRef.current && prependFromHeightRef.current !== null) {
        list.scrollTop += list.scrollHeight - prependFromHeightRef.current;
      }
    }
    if (firstId !== firstIdRef.current) prependFromHeightRef.current = null;
    firstIdRef.current = firstId;
    lastIdRef.current = lastId;
  }, [messages]);

  function handleLoadOlder() {
    prependFromHeightRef.current = listRef.current?.scrollHeight ?? null;
    onLoadOlder?.();
  }

  // A reaction can be refused (too many different ones on the message, no permission, offline): say so
  // for a few seconds instead of letting the click silently do nothing.
  function react(messageId: string, emoji: string, alreadyReacted: boolean) {
    setReactionError(null);
    Promise.resolve(onReact(messageId, emoji, alreadyReacted)).catch((err) => {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setReactionError(
        code === "too_many_reactions"
          ? "This message already has the maximum number of different reactions."
          : code === "forbidden"
            ? "You don't have permission to react here."
            : "Couldn't add that reaction."
      );
      setTimeout(() => setReactionError(null), 5000);
    });
  }

  const hasReacted = (m: Message, emoji: string) => m.reactions.some((r) => r.emoji === emoji && r.users.includes(selfUsername));

  if (messages.length === 0) {
    // Inside .message-list so it flexes to fill the column; otherwise the composer
    // sits directly under the text instead of at the bottom of the window.
    return (
      <div className="message-list">
        <div className="empty-state">No messages yet. Say hello!</div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={listRef}>
      {hasMore && (
        <div className="load-older">
          <button className="btn-secondary" style={{ borderRadius: 6 }} onClick={handleLoadOlder} disabled={loadingOlder}>
            {loadingOlder ? "Loading…" : "Load older messages"}
          </button>
        </div>
      )}
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
                    <input {...noAutofill} value={editValue} onChange={(e) => setEditValue(e.target.value)} autoFocus />
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
                        onClick={() => react(m.id, r.emoji, r.users.includes(selfUsername))}
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
                    <span key={emoji} className="message-action" onClick={() => react(m.id, emoji, hasReacted(m, emoji))}>
                      {emoji}
                    </span>
                  ))}
                  <button
                    type="button"
                    className="message-action"
                    title="More reactions"
                    aria-label="More reactions"
                    aria-haspopup="dialog"
                    aria-expanded={picker?.messageId === m.id}
                    {...{ [EMOJI_PICKER_TRIGGER_ATTR]: "" }}
                    onClick={(e) =>
                      setPicker(
                        picker?.messageId === m.id
                          ? null
                          : { messageId: m.id, anchor: e.currentTarget.getBoundingClientRect() }
                      )
                    }
                  >
                    +
                  </button>
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
      {picker && (
        <EmojiPopover
          anchor={picker.anchor}
          onPick={(emoji) => {
            const target = messages.find((m) => m.id === picker.messageId);
            if (target) react(target.id, emoji, hasReacted(target, emoji));
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {reactionError && (
        <div className="reaction-error" role="alert">
          {reactionError}
        </div>
      )}
    </div>
  );
}
