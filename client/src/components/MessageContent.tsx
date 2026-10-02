import { useState } from "react";
import * as api from "../api";
import type { MessageEmoticon } from "../api";
import { mediaUrl } from "../api";

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
  const parts = content.split(TRIGGER_RE);
  return (
    <>
      {parts.map((part, i) => {
        const emoticon = byTrigger.get(part);
        if (emoticon) {
          return <EmoticonImage key={i} emoticon={emoticon} currentUserId={currentUserId} />;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function EmoticonImage({ emoticon, currentUserId }: { emoticon: MessageEmoticon; currentUserId: string }) {
  const [saved, setSaved] = useState(false);
  const canSave = emoticon.creatorId !== currentUserId && emoticon.allowSave && !saved;

  async function handleClick() {
    if (!canSave) return;
    try {
      await api.saveEmoticon(emoticon.id);
      setSaved(true);
    } catch {
      // ignore - not critical if a click-to-save fails, user can retry
    }
  }

  return (
    <img
      src={mediaUrl(emoticon.imageUrl)}
      alt={emoticon.trigger}
      title={canSave ? `${emoticon.trigger} - click to save to your collection` : saved ? `${emoticon.trigger} (saved!)` : emoticon.trigger}
      onClick={handleClick}
      style={{
        height: 22,
        verticalAlign: "middle",
        cursor: canSave ? "pointer" : "default",
        outline: saved ? "2px solid var(--online)" : "none",
        borderRadius: 4,
      }}
    />
  );
}
