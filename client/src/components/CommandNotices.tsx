import { cardsOf } from "../lib/richEmbeds";
import { noticeText, type Notice } from "../lib/commandNotices";
import Button from "./Button";
import RichEmbedCard from "./RichEmbedCard";

/**
 * What a person sees after running a slash command until it is answered: "Waiting for Robo…", "Robo is thinking…", "Robo didn't respond to /request.", and a
 * private reply (text and cards) that only they can see. All of it is local to this page: nothing is stored, and it is gone on reload or when the channel is
 * left. A public answer is an ordinary message in the list, which clears the notice.
 */
export default function CommandNotices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (interactionId: string) => void }) {
  if (notices.length === 0) return null;
  return (
    <div className="command-notices" role="region" aria-live="polite" aria-label="Replies to your commands">
      {notices.map((notice) => (
        <div key={notice.interactionId} className={`command-notice command-notice-${notice.kind}`}>
          <div className="command-notice-head">
            <span className={notice.kind === "private" ? "hint" : undefined}>{noticeText(notice)}</span>
            {(notice.kind === "private" || notice.kind === "failed") && (
              <Button type="button" size="sm" variant="ghost" aria-label={`Dismiss the reply to /${notice.commandName}`} onClick={() => onDismiss(notice.interactionId)}>
                ✕
              </Button>
            )}
          </div>
          {notice.kind === "private" && (
            <>
              {notice.content !== "" && <div className="command-notice-text">{notice.content}</div>}
              {cardsOf(notice.richEmbeds, false).map((card, i) => (
                <RichEmbedCard key={i} card={card} />
              ))}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
