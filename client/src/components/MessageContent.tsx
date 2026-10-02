import { mediaUrl } from "../api";

const TRIGGER_RE = /(:[a-z0-9_]+:)/g;

export default function MessageContent({
  content,
  emoticons,
}: {
  content: string;
  emoticons: Map<string, string>;
}) {
  const parts = content.split(TRIGGER_RE);
  return (
    <>
      {parts.map((part, i) => {
        const imageUrl = emoticons.get(part);
        if (imageUrl) {
          return <img key={i} src={mediaUrl(imageUrl)} alt={part} title={part} style={{ height: 22, verticalAlign: "middle" }} />;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
