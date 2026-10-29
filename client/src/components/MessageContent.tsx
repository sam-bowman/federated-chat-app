import { useState } from "react";
import type { MessageEmoticon } from "../api";
import { mediaUrl } from "../api";
import { isEmojiOnly, splitEmoji } from "../lib/emojiText";
import { splitLinks } from "../lib/linkify";
import SaveEmoticonModal from "./SaveEmoticonModal";

const TRIGGER_RE = /(:[a-z0-9_]+:)/g;

type Token =
  | { kind: "link"; text: string; href: string }
  | { kind: "emoticon"; emoticon: MessageEmoticon }
  | { kind: "emoji"; text: string }
  | { kind: "text"; text: string };

/**
 * The message cut into what it is made of, in order. Addresses are found first, in the whole text: an address can contain something
 * shaped like a trigger (`/a:b:c`), which must stay part of the address. Emoticons are then found in the text between the links, and
 * Unicode emoji in what is left of that.
 */
function tokenize(content: string, byTrigger: Map<string, MessageEmoticon>): Token[] {
  const tokens: Token[] = [];
  for (const piece of splitLinks(content)) {
    if (piece.kind === "link") {
      tokens.push({ kind: "link", text: piece.text, href: piece.href });
      continue;
    }
    for (const part of piece.text.split(TRIGGER_RE)) {
      const emoticon = byTrigger.get(part);
      if (emoticon) tokens.push({ kind: "emoticon", emoticon });
      else for (const run of splitEmoji(part)) tokens.push(run.kind === "emoji" ? { kind: "emoji", text: run.text } : { kind: "text", text: run.text });
    }
  }
  return tokens;
}

export default function MessageContent({
  content,
  emoticons,
  currentUserId,
}: {
  content: string;
  emoticons: MessageEmoticon[];
  currentUserId: string;
}) {
  const byTrigger = new Map(emoticons.map((e) => [e.trigger, e]));
  const tokens = tokenize(content, byTrigger);
  const body = tokens.map((token, i) => {
    switch (token.kind) {
      case "link":
        // Opens somewhere else, so it must not be able to reach back into this page (noopener) or pass it on (noreferrer).
        return (
          <a key={i} className="message-link" href={token.href} target="_blank" rel="noopener noreferrer nofollow">
            {token.text}
          </a>
        );
      case "emoticon":
        return <EmoticonImage key={i} emoticon={token.emoticon} currentUserId={currentUserId} />;
      case "emoji":
        return (
          <span key={i} className="emoji">
            {token.text}
          </span>
        );
      default:
        return <span key={i}>{token.text}</span>;
    }
  });
  // Only a message of emoji gets a wrapper; every other message is exactly what it was.
  return isEmojiOnly(tokens) ? <span className="message-jumbo">{body}</span> : <>{body}</>;
}

function EmoticonImage({ emoticon, currentUserId }: { emoticon: MessageEmoticon; currentUserId: string }) {
  const [saved, setSaved] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const canSave = emoticon.creatorId !== currentUserId && emoticon.allowSave && !saved;

  return (
    <>
      <img
        className="emoticon-image"
        src={mediaUrl(emoticon.imageUrl)}
        alt={emoticon.trigger}
        title={canSave ? `${emoticon.trigger} - click to save to your collection` : saved ? `${emoticon.trigger} (saved!)` : emoticon.trigger}
        onClick={() => canSave && setShowSaveModal(true)}
        style={{
          cursor: canSave ? "pointer" : "default",
          outline: saved ? "2px solid var(--online)" : "none",
        }}
      />
      {showSaveModal && (
        <SaveEmoticonModal emoticon={emoticon} onSaved={() => setSaved(true)} onClose={() => setShowSaveModal(false)} />
      )}
    </>
  );
}
