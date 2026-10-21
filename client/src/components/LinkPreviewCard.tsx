import type { Embed } from "../api";
import { previewHost, previewHref } from "../lib/linkPreviews";
import Button from "./Button";

/**
 * What a message's link's page says about itself: its title (a link to it), a short description, and the site. All of it is the
 * page's own text, so it is only ever drawn as text, and the real address's host is always shown beside it (a page may call itself
 * anything). There is no picture: drawing one would make every reader's browser contact the linked site. The author gets a button to
 * take the previews off their message.
 */
export default function LinkPreviewCard({ embed, onRemove }: { embed: Embed; onRemove?: () => void }) {
  const href = previewHref(embed.url);
  if (!href || (embed.title === null && embed.description === null)) return null;
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
      </div>
      {onRemove && (
        <Button variant="ghost" size="sm" className="link-preview-remove" aria-label={`Remove the preview of ${host}`} title="Remove this preview for everyone" onClick={onRemove}>
          ✕
        </Button>
      )}
    </aside>
  );
}
