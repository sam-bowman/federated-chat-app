import { useCallback, useEffect, useState } from "react";
import * as api from "../api";

/** How often the number is asked again while the page is open and in view. Reports are not urgent in seconds, and each ask is one cheap count. */
export const OPEN_REPORTS_EVERY_MS = 60_000;

/**
 * How many reports are waiting for this reviewer (#296): one community's, or the server's when `communityId` is null. Asked when the page
 * opens, again every minute while it is in view, and when the person comes back to it; never while it is hidden. `enabled` is false for
 * anyone who cannot review (nothing is asked then, and the count is null). A failed ask keeps the last number: a badge that flickers
 * away on a bad connection is worse than one a minute old.
 *
 * `set` is for the queue itself, which knows the exact number the moment a report is closed or reopened.
 */
export function useOpenReports(communityId: string | null, enabled: boolean): { count: number | null; set: (count: number) => void } {
  // Remembered with the queue it belongs to, so moving to another community never shows the last one's number.
  const key = communityId ?? "admin";
  const [known, setKnown] = useState<{ key: string; count: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const ask = () => {
      if (document.hidden) return;
      api
        .getOpenReportCount(communityId)
        .then(({ open }) => current && setKnown({ key, count: open }))
        .catch(() => undefined);
    };
    ask();
    const every = setInterval(ask, OPEN_REPORTS_EVERY_MS);
    document.addEventListener("visibilitychange", ask);
    window.addEventListener("focus", ask);
    return () => {
      current = false;
      clearInterval(every);
      document.removeEventListener("visibilitychange", ask);
      window.removeEventListener("focus", ask);
    };
  }, [communityId, enabled, key]);

  const set = useCallback((count: number) => setKnown({ key, count }), [key]);
  return { count: enabled && known?.key === key ? known.count : null, set };
}

/** "2 reports", "1 report": what the badge on a button says. */
export const waitingLabel = (count: number): string => (count === 1 ? "1 report" : `${count} reports`);
