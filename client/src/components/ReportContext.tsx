import { useState } from "react";
import * as api from "../api";
import type { ReportContext as Context } from "../api";
import Button from "./Button";

interface Props {
  communityId: string;
  reportId: string;
}

const NOTE: Record<Context["state"], string | null> = {
  same: null,
  edited: "This message was edited after it was reported. The report above shows what it said then.",
  deleted: "This message has been deleted since it was reported. The report above still holds what it said.",
  gone: "This message is no longer there, so there is nothing to show around it. The report above still holds what it said.",
};

const who = (sender: { identity: string | null; displayName: string | null }) =>
  [sender.displayName, sender.identity ? `(${sender.identity})` : null].filter(Boolean).join(" ") || "Someone";

/**
 * The channel around a reported message, as it is now (#296): five messages either side, so a moderator can judge it in context. Asked for
 * when the reviewer opens it, every time, so it is never older than the click. The report keeps its own snapshot: this is for context
 * only, and says when the message has changed or gone. Everything in it is a stranger's text, drawn only as text. A community's reviewers
 * only (the admins' queue shows what was reported and nothing around it).
 */
export default function ReportContext({ communityId, reportId }: Props) {
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function show() {
    setShown(true);
    setLoading(true);
    setError(null);
    try {
      setContext((await api.getReportContext(communityId, reportId)).context);
    } catch {
      setContext(null);
      setError("Couldn't load the messages around it. Try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!shown) {
    return (
      <div className="report-actions">
        <Button size="sm" variant="secondary" onClick={() => void show()}>
          Show the messages around it
        </Button>
      </div>
    );
  }

  return (
    <div className="report-context">
      <div className="report-actions">
        <Button size="sm" variant="secondary" onClick={() => setShown(false)}>
          Hide the messages around it
        </Button>
        <Button size="sm" variant="secondary" busy={loading} disabled={loading} onClick={() => void show()}>
          Refresh
        </Button>
      </div>
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
      {loading && !context && <p className="hint">Loading…</p>}
      {context && (
        <>
          {NOTE[context.state] && <p className="hint">{NOTE[context.state]}</p>}
          {context.messages.length > 0 && (
            <ol className="report-context-list" aria-label={`Messages around the reported one${context.channel ? ` in # ${context.channel}` : ""}`}>
              {context.messages.map((m) => (
                <li key={m.id} className={`report-context-message${m.reported ? " reported" : ""}`} aria-current={m.reported ? "true" : undefined}>
                  <div className="report-meta">
                    {who(m.sender)} · <time dateTime={m.at}>{new Date(m.at).toLocaleString()}</time>
                    {m.reported && <strong> · the reported message</strong>}
                  </div>
                  {m.text === null ? (
                    <span className="hint">Deleted</span>
                  ) : (
                    <span className="report-context-text">{m.text || (m.attachmentCount > 0 ? "" : "No text")}</span>
                  )}
                  {m.attachmentCount > 0 && <span className="hint"> {m.attachmentCount === 1 ? "1 attachment" : `${m.attachmentCount} attachments`}</span>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
