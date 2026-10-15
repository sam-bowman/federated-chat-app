import { useState } from "react";

/**
 * A channel's topic, shown beside its name in the channel header: one line, cut off with an
 * ellipsis when long, with the whole text in the tooltip and a click to expand it in place.
 * Nothing at all when there is no topic.
 *
 * The topic is typed by a user, so it is only ever rendered as text (React escapes it);
 * markup in it shows literally. Key this by channel id so the expanded state does not carry
 * over to the next channel.
 */
export default function ChannelTopic({ topic }: { topic: string | null | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const text = topic?.trim();
  if (!text) return null;

  return (
    <button
      type="button"
      className={`channel-topic${expanded ? " expanded" : ""}`}
      title={text}
      aria-expanded={expanded}
      onClick={() => setExpanded((open) => !open)}
    >
      {text}
    </button>
  );
}
