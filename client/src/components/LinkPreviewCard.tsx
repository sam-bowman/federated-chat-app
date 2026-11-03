import type { Embed } from "../api";
import { mediaUrl } from "../api";
import { previewHost, previewHref, previewPicture, useLinkPreviewPicturesShown } from "../lib/linkPreviews";
import Button from "./Button";

/**
 * What a message's link's page says about itself: its title (a link to it), a short description, and the site. All of it is the
 * page's own text, so it is only ever drawn as text, and the real address's host is always shown beside it (a page may call itself
 * anything). A picture (#244) is a copy a server of the federation kept, never the linked site's own file: the message's own server fetched it
 * once, so drawing it makes this browser ask that server and the linked site never hears of the reader. It is drawn only when the server says
 * there is one, it is a plain http(s) address of a sane size, and the person has not turned pictures off on this device. A click on it goes to
 * the page. The author gets a button to take the previews off their message.
 */
export default function LinkPreviewCard({ embed, onRemove }: { embed: Embed; onRemove?: () => void }) {
  const picturesShown = useLinkPreviewPicturesShown();
  const href = previewHref(embed.url);
  const picture = picturesShown ? previewPicture(embed.image) : null;
  if (!href || (embed.title === null && embed.description === null && !picture)) return null;
  const host = previewHost(href);
  const site = embed.siteName && embed.siteName.toLowerCase() !== host.toLowerCase() ? `${embed.siteName} · ${host}` : host;
  return (
    <aside className="link-preview" aria-label={`Link preview: ${host}`}>
      <div className="link-preview-body">
        <span className="link-preview-site">{site}</span>
        {embed.title && (
          <a className="link-preview-title" href={href} target="_blank" rel="noopener noreferrer nofollow">
            {embed.title}
          </a>
        )}
        {embed.description && <span className="link-preview-description">{embed.description}</span>}
        {picture && (
          <a className="link-preview-picture" href={href} target="_blank" rel="noopener noreferrer nofollow">
            {/* The one place a preview's picture is drawn. No referrer is sent with the request. */}
            <img
              className="link-preview-image"
              src={mediaUrl(picture.src)}
              width={picture.width}
              height={picture.height}
              alt={embed.title ?? host}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              draggable={false}
            />
          </a>
        )}
      </div>
      {onRemove && (
        <Button variant="ghost" size="sm" className="link-preview-remove" aria-label={`Remove the preview of ${host}`} title="Remove this preview for everyone" onClick={onRemove}>
          ✕
        </Button>
      )}
    </aside>
  );
}
