import { useState } from "react";
import type { MessageEmoticon } from "../api";
import { mediaUrl } from "../api";
import { splitLinks } from "../lib/linkify";
import SaveEmoticonModal from "./SaveEmoticonModal";

const TRIGGER_RE = /(:[a-z0-9_]+:)/g;

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
  // Addresses are found first, in the whole text: an address can contain something shaped like a trigger (`/a:b:c`), which
  // must stay part of the address. Emoticons are then found in the text between the links.
  return (
    <>
      {splitLinks(content).map((piece, i) =>
        piece.kind === "link" ? (
          // Opens somewhere else, so it must not be able to reach back into this page (noopener) or pass it on (noreferrer).
          <a key={i} className="message-link" href={piece.href} target="_blank" rel="noopener noreferrer nofollow">
            {piece.text}
          </a>
        ) : (
          piece.text.split(TRIGGER_RE).map((part, j) => {
            const emoticon = byTrigger.get(part);
            if (emoticon) {
              return <EmoticonImage key={`${i}.${j}`} emoticon={emoticon} currentUserId={currentUserId} />;
            }
            return <span key={`${i}.${j}`}>{part}</span>;
          })
        )
      )}
    </>
  );
}

function EmoticonImage({ emoticon, currentUserId }: { emoticon: MessageEmoticon; currentUserId: string }) {
  const [saved, setSaved] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const canSave = emoticon.creatorId !== currentUserId && emoticon.allowSave && !saved;

  return (
    <>
      <img
        src={mediaUrl(emoticon.imageUrl)}
        alt={emoticon.trigger}
        title={canSave ? `${emoticon.trigger} - click to save to your collection` : saved ? `${emoticon.trigger} (saved!)` : emoticon.trigger}
        onClick={() => canSave && setShowSaveModal(true)}
        style={{
          height: "1.375rem",
          verticalAlign: "middle",
          cursor: canSave ? "pointer" : "default",
          outline: saved ? "2px solid var(--online)" : "none",
          borderRadius: "0.25rem",
        }}
      />
      {showSaveModal && (
        <SaveEmoticonModal emoticon={emoticon} onSaved={() => setSaved(true)} onClose={() => setShowSaveModal(false)} />
      )}
    </>
  );
}
