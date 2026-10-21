import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AuditEntry, AuditPage, AuditQuery } from "../api";
import { AUDIT_ACTION_OPTIONS, SOURCE_LABELS, describeAudit } from "../lib/auditText";
import Button from "./Button";

interface Props {
  /** Fetches one page. The list asks again, with `before`, for older ones. */
  load: (query: AuditQuery) => Promise<AuditPage>;
  /** `community`: the moderation actions only (a community's own view). `server`: everything, with the source filter too. */
  scope: "community" | "server";
  /** Whether each line says which community it was in (for the whole-server view). */
  showCommunity?: boolean;
}

const PAGE_SIZE = 50;

/**
 * The audit log (#59), newest first: one sentence per entry saying who did what to what, with when and where it came from. Everything shown
 * is text from the server (names can be anything a person typed) and is only ever drawn as text. It reads, filters and pages; there is nothing
 * to change, because the log cannot be changed.
 */
export default function AuditLogList({ load, scope, showCommunity = false }: Props) {
  const actionId = useId();
  const sourceId = useId();
  const [action, setAction] = useState("");
  const [source, setSource] = useState("");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the latest question may answer: choosing a filter while an older one is on its way must not put the older answer on screen.
  const asked = useRef(0);

  const fetchPage = useCallback(
    async (before: number | undefined, replace: boolean) => {
      const mine = ++asked.current;
      setLoading(true);
      setError(null);
      try {
        const page = await load({ before, limit: PAGE_SIZE, ...(action ? { action } : {}), ...(source ? { source } : {}) });
        if (mine !== asked.current) return;
        setEntries((prev) => (replace ? page.entries : [...prev, ...page.entries]));
        setNext(page.next);
      } catch {
        if (mine !== asked.current) return;
        setError("Couldn't load the audit log. Try again.");
      } finally {
        if (mine === asked.current) setLoading(false);
      }
    },
    [load, action, source]
  );

  useEffect(() => {
    void fetchPage(undefined, true);
  }, [fetchPage]);

  const actions = AUDIT_ACTION_OPTIONS.filter((o) => scope === "server" || o.scope === "community");

  return (
    <div className="audit-log">
      <div className="audit-log-filters">
        <label htmlFor={actionId}>Show</label>
        <select id={actionId} value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">Everything</option>
          {actions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {scope === "server" && (
          <>
            <label htmlFor={sourceId}>Done</label>
            <select id={sourceId} value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Anywhere</option>
              {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
      {!error && !loading && entries.length === 0 && <div className="empty-state">Nothing has been recorded{action || source ? " for that" : " yet"}.</div>}

      {entries.length > 0 && (
        <ul className="audit-log-entries" aria-label="Audit log">
          {entries.map((entry) => (
            <li key={entry.id} className="audit-log-entry">
              <span className="audit-log-sentence">{describeAudit(entry)}</span>
              <span className="audit-log-meta">
                <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
                {" · "}
                {SOURCE_LABELS[entry.source] ?? entry.source}
                {showCommunity && entry.community && ` · ${entry.community.name ?? entry.community.id}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {(next !== null || (loading && entries.length > 0)) && (
        <Button type="button" variant="secondary" busy={loading} disabled={loading || next === null} onClick={() => next !== null && void fetchPage(next, false)}>
          Load older
        </Button>
      )}
      {loading && entries.length === 0 && !error && <p className="hint">Loading…</p>}
    </div>
  );
}
