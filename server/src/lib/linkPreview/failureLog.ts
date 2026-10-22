import type { FetchResult } from "./fetchPage.js";

// A page that could not be read is only "no preview" to the person who sent the link, so without this the operator would never find out that
// the server cannot look up names at all (#236: every link silently got no card). Only connection problems are worth a line: a page that
// answered 404, is not HTML or sits behind a refused address is the ordinary business of a link and would be noise. Kept free of config.ts and
// the database so it can be unit-tested on its own.

/** Looking up the name failed: for one mistyped link that is ordinary, for every link it means the server cannot look up names. */
const NAME_LOOKUP_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

const LOOKUP_HINT =
  "The name could not be looked up. A mistyped link does this; if it happens for every link, the server cannot look up names at all (see docs/deployment/kubernetes.md, Link previews do nothing).";

type Failure = Extract<FetchResult, { ok: false }>;

/** Says why a page could not be read, at most once for each reason (and code) in `everyMs`, so a busy server does not fill its log. */
export function createFailureReporter(log: (format: string, ...args: string[]) => void, everyMs = 5 * 60 * 1000) {
  const lastSaid = new Map<string, number>();
  return (failure: Failure, now: number = Date.now()): boolean => {
    if (failure.reason !== "error" && failure.reason !== "timeout") return false;
    const key = `${failure.reason}:${failure.code ?? ""}`;
    const before = lastSaid.get(key);
    if (before !== undefined && now - before < everyMs) return false;
    lastSaid.set(key, now);
    // The reason and code are the server's own words (a code is checked to be a short plain one), never the person's link, and they are
    // arguments, never part of the format.
    log("[link preview] could not read a page: %s (%s). %s", failure.reason, failure.code ?? "no code", failure.code && NAME_LOOKUP_CODES.has(failure.code) ? LOOKUP_HINT : "");
    return true;
  };
}
