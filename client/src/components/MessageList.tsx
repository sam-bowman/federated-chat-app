import { Fragment, useLayoutEffect, useRef, useState } from "react";
import type { Message, ReactionChoice } from "../api";
import { mediaUrl } from "../api";
import Avatar from "./Avatar";
import { ApiError } from "../api/client";
import { EMOJI_PICKER_TRIGGER_ATTR, EmojiPopover } from "./EmojiPicker";
import EmoticonThumb from "./EmoticonThumb";
import type { EmoticonSets } from "../lib/emoticonSets";
import { QUICK_REACTIONS, choiceOf, hasReacted as hasReactedWith, reactionKey } from "../lib/reactions";
import MessageContent from "./MessageContent";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";
import InviteMessage from "./InviteMessage";
import UserLink from "./UserLink";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface Props {
  messages: Message[];
  selfId: string;
  selfUsername: string;
  onReact: (messageId: string, choice: ReactionChoice, alreadyReacted: boolean) => void | Promise<unknown>;
  /**
   * What the person may react with besides Unicode emoji: their own emoticons, saved ones and their communities'.
   * Every one is usable whatever its trigger (a reaction names the emoticon, not the trigger, so a trigger another
   * emoticon shadows does not matter). Leave out for an emoji-only picker.
   */
  emoticons?: EmoticonSets;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onDelete: (messageId: string) => void;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** The community the messages are in, so a profile opened from here shows the person's roles there. */
  communityId?: string;
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
  emoticons,
  onEdit,
  onDelete,
  hasMore,
  loadingOlder,
  onLoadOlder,
  communityId,
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
  function react(messageId: string, choice: ReactionChoice, alreadyReacted: boolean) {
    setReactionError(null);
    Promise.resolve(onReact(messageId, choice, alreadyReacted)).catch((err) => {
      const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setReactionError(
        code === "too_many_reactions"
          ? "This message already has the maximum number of different reactions."
          : code === "forbidden"
            ? "You don't have permission to react here."
            : code === "emoticon_not_available"
              ? "You can't use that emoticon."
              : "Couldn't add that reaction."
      );
      setTimeout(() => setReactionError(null), 5000);
    });
  }

  const hasReacted = (m: Message, choice: ReactionChoice) => hasReactedWith(m, choice, selfUsername);

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
          <Button onClick={handleLoadOlder} disabled={loadingOlder} variant="secondary">
            {loadingOlder ? "Loading…" : "Load older messages"}
          </Button>
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
                {grouped ? (
                  <span className="hover-timestamp">{formatTime(m.createdAt)}</span>
                ) : (
                  <UserLink user={m.sender} communityId={communityId} label={`View ${m.sender.displayName}'s profile`} className="user-link-avatar">
                    <Avatar user={m.sender} />
                  </UserLink>
                )}
              </div>
              <div className="message-body">
                {!grouped && (
                  <div className="message-header">
                    <UserLink user={m.sender} communityId={communityId}>
                      <span className="message-author">{own ? "You" : m.sender.displayName}</span>
                    </UserLink>
                    <span className="message-time">{formatTime(m.createdAt)}</span>
                  </div>
                )}
                {m.replyTo && (
                  <div className="hint" style={{ marginBottom: "0.125rem" }}>
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
                    style={{ display: "flex", gap: "0.375rem" }}
                  >
                    <input {...noAutofill} value={editValue} onChange={(e) => setEditValue(e.target.value)} autoFocus />
                    <Button type="submit">
                      Save
                    </Button>
                  </form>
                ) : m.invite ? (
                  <InviteMessage invite={m.invite} senderName={m.sender.displayName} isOwn={m.sender.id === selfId} />
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
                      <button
                        key={reactionKey(r)}
                        type="button"
                        className={`reaction-pill ${r.users.includes(selfUsername) ? "mine" : ""}`}
                        aria-pressed={r.users.includes(selfUsername)}
                        onClick={() => react(m.id, choiceOf(r), r.users.includes(selfUsername))}
                        // An emoticon can look just like an emoji, so its name is what tells them apart.
                        title={r.emoticon ? `${r.emoticon.name}: ${r.users.join(", ")}` : r.users.join(", ")}
                      >
                        {r.emoticon ? <EmoticonThumb emoticon={r.emoticon} alt={r.emoticon.name} /> : r.emoji} {r.count}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {!m.deletedAt && !isEditing && (
                <div className="message-actions">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="message-action"
                      aria-label={`React with ${emoji}`}
                      onClick={() => react(m.id, { emoji }, hasReacted(m, { emoji }))}
                    >
                      {emoji}
                    </button>
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
                      {/* An invitation is its card: editing the text under it would only make the two disagree. */}
                      {!m.invite && (
                        <button
                          type="button"
                          className="message-action"
                          title="Edit"
                          aria-label="Edit message"
                          onClick={() => {
                            setEditingId(m.id);
                            setEditValue(m.content ?? "");
                          }}
                        >
                          ✎
                        </button>
                      )}
                      <button
                        type="button"
                        className="message-action"
                        title="Delete"
                        aria-label="Delete message"
                        onClick={() => onDelete(m.id)}
                      >
                        🗑
                      </button>
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
          emoticons={emoticons}
          communityId={communityId}
          onPick={(emoji) => {
            const target = messages.find((m) => m.id === picker.messageId);
            if (target) react(target.id, { emoji }, hasReacted(target, { emoji }));
            setPicker(null);
          }}
          onPickEmoticon={(emoticon) => {
            const target = messages.find((m) => m.id === picker.messageId);
            const choice = { emoticon: { id: emoticon.id, name: emoticon.name, imageUrl: emoticon.imageUrl } };
            if (target) react(target.id, choice, hasReacted(target, choice));
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
