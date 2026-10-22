import { describe, expect, it } from "vitest";
import { createFailureReporter } from "./failureLog.js";

const make = (everyMs?: number) => {
  const lines: string[][] = [];
  const report = createFailureReporter((...args) => lines.push(args), everyMs);
  return { report, lines };
};
const MINUTE = 60_000;

describe("the failure log", () => {
  it("says a name could not be looked up, with the way to find out more", () => {
    const { report, lines } = make();
    expect(report({ ok: false, reason: "error", code: "ENOTFOUND" }, 0)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0].slice(0, 3)).toEqual(["[link preview] could not read a page: %s (%s). %s", "error", "ENOTFOUND"]);
    expect(lines[0][3]).toContain("cannot look up names");
    expect(lines[0][3]).toContain("docs/deployment/kubernetes.md");
  });

  it("gives the same hint for a lookup that timed out, and none for other connection errors", () => {
    const { report, lines } = make();
    report({ ok: false, reason: "error", code: "EAI_AGAIN" }, 0);
    report({ ok: false, reason: "error", code: "ECONNREFUSED" }, 0);
    report({ ok: false, reason: "error" }, 0);
    expect(lines.map((l) => [l[1], l[2], l[3] === ""])).toEqual([
      ["error", "EAI_AGAIN", false],
      ["error", "ECONNREFUSED", true],
      ["error", "no code", true],
    ]);
  });

  it("is quiet about what is the ordinary business of a link", () => {
    const { report, lines } = make();
    for (const reason of ["not_http", "bad_port", "blocked", "too_many_redirects", "not_html", "status"] as const) {
      expect(report({ ok: false, reason }, 0), reason).toBe(false);
    }
    expect(lines).toHaveLength(0);
    expect(report({ ok: false, reason: "timeout" }, 0)).toBe(true);
  });

  it("says each reason once in five minutes, and again after that", () => {
    const { report, lines } = make();
    expect(report({ ok: false, reason: "error", code: "ENOTFOUND" }, 0)).toBe(true);
    expect(report({ ok: false, reason: "error", code: "ENOTFOUND" }, 5 * MINUTE - 1)).toBe(false);
    expect(report({ ok: false, reason: "error", code: "ENOTFOUND" }, 5 * MINUTE)).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it("keeps a count for each reason and code of its own, so one chatty problem does not hide another", () => {
    const { report } = make();
    expect(report({ ok: false, reason: "error", code: "ENOTFOUND" }, 0)).toBe(true);
    expect(report({ ok: false, reason: "error", code: "ECONNRESET" }, 1)).toBe(true);
    expect(report({ ok: false, reason: "timeout" }, 2)).toBe(true);
    expect(report({ ok: false, reason: "error", code: "ENOTFOUND" }, 3)).toBe(false);
  });

  it("can be told how long to stay quiet", () => {
    const { report } = make(1000);
    expect(report({ ok: false, reason: "timeout" }, 0)).toBe(true);
    expect(report({ ok: false, reason: "timeout" }, 999)).toBe(false);
    expect(report({ ok: false, reason: "timeout" }, 1000)).toBe(true);
  });
});
