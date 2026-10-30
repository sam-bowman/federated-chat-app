import { useId, useState } from "react";
import * as api from "../api";
import type { Report, ResolveAction } from "../api";
import { ApiError } from "../api/client";
import { MAX_NOTE, RESOLVE_ACTION_OPTIONS, historyLine, kindLabel, reasonLabel, resolutionLine } from "../lib/reports";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";
import ReportSnapshot from "./ReportSnapshot";

interface Props {
  report: Report;
  /** The community whose queue this is, or null for the admins'. */
  communityId: string | null;
  /** Called with the report as the server now has it, after it was closed or reopened. */
  onChanged: (report: Report) => void;
}

type Closing = null | "resolve" | "dismiss";

/** What went wrong closing or reopening, in words. Someone else may have closed it first. */
function failure(err: unknown): string {
  const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
  if (code === "not_open") return "Someone else has already closed this report. Reload the list to see how.";
  if (code === "not_closed") return "This report is already open.";
  if (code === "not_found") return "This report isn't available any more.";
  return "That didn't work. Try again.";
}

/**
 * One report in a queue (#58): why it was made, by whom (with how many reports they have made, so a pattern of false ones shows), what
 * was reported, and what a reviewer can do about it. Resolving records what was done; it does not do it. Taking the action (deleting
 * the message, removing the member) is done where it always was, and the choice here only says which.
 */
export default function ReportCard({ report, communityId, onChanged }: Props) {
  const fieldId = useId();
  const [closing, setClosing] = useState<Closing>(null);
  const [action, setAction] = useState<ResolveAction>("none");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(call: () => Promise<{ report: Report }>) {
    setBusy(true);
    setError(null);
    try {
      const { report: updated } = await call();
      setClosing(null);
      setNote("");
      onChanged(updated);
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  const history = historyLine(report.reporter.history, communityId !== null);
  const closed = resolutionLine(report);

  return (
    <li className="report-card" aria-label={`${reasonLabel(report.reason)}: report about ${kindLabel(report.kind)}`}>
      <div className="report-head">
        <strong>{reasonLabel(report.reason)}</strong>
        <span className="report-meta">
          {kindLabel(report.kind)} · <time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time>
          {communityId === null && ` · ${report.scope === "community" ? "went to the community's moderators" : "for the admins only"}`}
        </span>
      </div>

      <div className="report-meta">
        Reported by {report.reporter.label}
        {history && ` (${history})`}
      </div>
      {report.details && (
        <p className="report-details">
          <span className="report-snapshot-label">In their words</span> {report.details}
        </p>
      )}

      <ReportSnapshot snapshot={report.snapshot} />

      {report.status === "open" ? (
        closing === null ? (
          <div className="report-actions">
            <Button size="sm" onClick={() => setClosing("resolve")}>
              Resolve
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setClosing("dismiss")}>
              Dismiss
            </Button>
          </div>
        ) : (
          <form
            className="report-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() =>
                closing === "resolve"
                  ? api.resolveReport(communityId, report.id, { action, ...(note.trim() ? { note: note.trim() } : {}) })
                  : api.dismissReport(communityId, report.id, note.trim() ? { note: note.trim() } : {})
              );
            }}
          >
            {closing === "resolve" ? (
              <>
                <label htmlFor={`${fieldId}-action`}>What was done?</label>
                <select id={`${fieldId}-action`} value={action} onChange={(e) => setAction(e.target.value as ResolveAction)} disabled={busy}>
                  {RESOLVE_ACTION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <p className="hint">This records what was done. To delete the message or remove someone, do it first, where you normally would.</p>
              </>
            ) : (
              <p className="hint">Dismiss this report: nothing more needs doing.</p>
            )}
            <label htmlFor={`${fieldId}-note`}>Note (optional, only reviewers see it)</label>
            <textarea {...noAutofill} id={`${fieldId}-note`} rows={2} maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
            <div className="report-actions">
              <Button type="submit" size="sm" busy={busy} disabled={busy}>
                {closing === "resolve" ? "Mark resolved" : "Dismiss report"}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setClosing(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )
      ) : (
        <div className="report-closed">
          <div>
            {closed}
            {report.resolution?.at && <span className="report-meta"> · {new Date(report.resolution.at).toLocaleString()}</span>}
          </div>
          {report.resolution?.note && (
            <p className="report-details">
              <span className="report-snapshot-label">Note</span> {report.resolution.note}
            </p>
          )}
          <div className="report-actions">
            <Button size="sm" variant="secondary" busy={busy} disabled={busy} onClick={() => void run(() => api.reopenReport(communityId, report.id))}>
              Reopen
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
    </li>
  );
}
