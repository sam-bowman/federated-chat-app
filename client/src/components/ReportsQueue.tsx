import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as api from "../api";
import type { Report } from "../api";
import Button from "./Button";
import ReportCard from "./ReportCard";

interface Props {
  /** The community whose queue this is (a reviewer's view), or null for everything that reaches the server (the admins'). */
  communityId: string | null;
}

type Filter = "open" | "resolved" | "dismissed" | "all";
const PAGE_SIZE = 25;

/**
 * The queue of reports (#58), newest first, opening on the ones still to look at. One component for a community's reviewers and the
 * server's admins: only what the server sends differs. Everything in a report is a stranger's text, drawn only as text.
 */
export default function ReportsQueue({ communityId }: Props) {
  const filterId = useId();
  const [filter, setFilter] = useState<Filter>("open");
  const [reports, setReports] = useState<Report[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the newest question may answer: choosing another filter while one is on its way must not put the older answer on screen.
  const asked = useRef(0);

  const fetchPage = useCallback(
    async (before: number | undefined, replace: boolean) => {
      const mine = ++asked.current;
      setLoading(true);
      setError(null);
      try {
        const page = await api.listReports(communityId, { before, limit: PAGE_SIZE, ...(filter === "all" ? {} : { status: filter }) });
        if (mine !== asked.current) return;
        setReports((prev) => (replace ? page.reports : [...prev, ...page.reports]));
        setNext(page.next);
        setOpen(page.open);
      } catch {
        if (mine !== asked.current) return;
        setError("Couldn't load the reports. Try again.");
      } finally {
        if (mine === asked.current) setLoading(false);
      }
    },
    [communityId, filter]
  );

  useEffect(() => {
    void fetchPage(undefined, true);
  }, [fetchPage]);

  function changed(updated: Report) {
    // A report that no longer belongs under the chosen filter leaves the list; the others stay put.
    const stays = filter === "all" || filter === updated.status;
    setReports((prev) => (stays ? prev.map((r) => (r.id === updated.id ? updated : r)) : prev.filter((r) => r.id !== updated.id)));
    const before = reports.find((r) => r.id === updated.id);
    if (before && before.status !== updated.status) {
      setOpen((n) => (n === null ? n : Math.max(0, n + (updated.status === "open" ? 1 : before.status === "open" ? -1 : 0))));
    }
  }

  return (
    <div className="reports">
      <div className="audit-log-filters">
        <label htmlFor={filterId}>Show</label>
        <select id={filterId} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="open">Still to look at</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
          <option value="all">Everything</option>
        </select>
        {open !== null && <span className="hint">{open === 1 ? "1 open report" : `${open} open reports`}</span>}
      </div>

      {error && <p className="error-text">{error}</p>}
      {!error && !loading && reports.length === 0 && (
        <div className="empty-state">{filter === "open" ? "Nothing to look at. No reports are waiting." : "No reports here."}</div>
      )}

      {reports.length > 0 && (
        <ul className="report-list" aria-label="Reports">
          {reports.map((report) => (
            <ReportCard key={report.id} report={report} communityId={communityId} onChanged={changed} />
          ))}
        </ul>
      )}

      {(next !== null || (loading && reports.length > 0)) && (
        <Button type="button" variant="secondary" busy={loading} disabled={loading || next === null} onClick={() => next !== null && void fetchPage(next, false)}>
          Load older
        </Button>
      )}
      {loading && reports.length === 0 && !error && <p className="hint">Loading…</p>}
    </div>
  );
}
