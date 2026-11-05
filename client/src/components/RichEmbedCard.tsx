import type { CSSProperties } from "react";
import { mediaUrl } from "../api";
import type { Card, Picture } from "../lib/richEmbeds";

/**
 * One picture of a card. The one place a card's pictures are drawn (a copy a server of the federation kept, never the bot author's own file, so
 * drawing it makes this browser ask a server of the federation and the bot's author never hears of the reader). No referrer is sent.
 */
function CardPicture({ picture, className, alt }: { picture: Picture; className: string; alt: string }) {
  return (
    <img
      className={className}
      src={mediaUrl(picture.src)}
      width={picture.width}
      height={picture.height}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
    />
  );
}

/**
 * A bot's card (#132): a stripe of the bot's colour, a title (a link when the bot gave an address), a description, fields (inline ones side by
 * side), a picture and a footer. All of it is the bot's own text, so it is only ever drawn as text: no markdown, and the only link is the title's.
 */
export default function RichEmbedCard({ card }: { card: Card }) {
  // The colour reaches CSS as a custom property, only when it is exactly #rrggbb (cardsOf checks).
  const style = card.colour ? ({ "--card-stripe": card.colour } as CSSProperties) : undefined;
  const label = card.title ? `Card: ${card.title}` : "Card";
  return (
    <article className="rich-card" style={style} aria-label={label}>
      <div className="rich-card-main">
        {card.title &&
          (card.href ? (
            <a className="rich-card-title" href={card.href} target="_blank" rel="noopener noreferrer nofollow">
              {card.title}
            </a>
          ) : (
            <span className="rich-card-title">{card.title}</span>
          ))}
        {card.description && <div className="rich-card-description">{card.description}</div>}
        {card.fields.length > 0 && (
          <dl className="rich-card-fields">
            {card.fields.map((field, i) => (
              <div key={i} className={field.inline ? "rich-card-field rich-card-field-inline" : "rich-card-field"}>
                <dt>{field.name}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {card.image && <CardPicture picture={card.image} className="rich-card-image" alt={card.title ?? "Picture on a card"} />}
        {card.footer && <div className="rich-card-footer">{card.footer}</div>}
      </div>
      {card.thumbnail && <CardPicture picture={card.thumbnail} className="rich-card-thumbnail" alt={card.title ?? "Picture on a card"} />}
    </article>
  );
}
