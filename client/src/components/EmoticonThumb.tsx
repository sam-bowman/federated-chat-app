import type { MessageEmoticon } from "../api";
import { mediaUrl } from "../api";

/**
 * A custom emoticon's picture, for the picker, the suggestions and reactions. It is the one place those
 * draw it, so there is one `<img src={mediaUrl(...)}>` for the code scanner to look at, not four.
 * `alt` is empty by default because the button around it carries the name.
 */
export default function EmoticonThumb({ emoticon, alt = "" }: { emoticon: Pick<MessageEmoticon, "imageUrl">; alt?: string }) {
  return <img className="emoticon-thumb" src={mediaUrl(emoticon.imageUrl)} alt={alt} draggable={false} />;
}
