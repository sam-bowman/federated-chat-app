// Decides how much of CI a run needs, so it can skip work that cannot tell us anything. Used by the
// `changes` job in .github/workflows/ci.yml; the decision logic is a pure function so it can be tested
// (ci-tier.test.mjs, run by that same job before the result is trusted).
//
// Tiers:
//   full  - everything. The default, and the answer for anything this file is not sure about.
//   light - a release-please version-bump PR: static checks and the build, but not the test suites. It
//           only changes version numbers and the changelog on top of a master that already passed.
//   docs  - only documentation changed: just the security scans.
//   push  - a push to master: just CodeQL. The commit has the content of a pull request that already
//           passed every check (merging requires an up-to-date branch), and CodeQL's analysis of the
//           default branch is the baseline pull-request alerts are compared with.
//
// Never skip CodeQL on a pull request: the branch ruleset requires its result for the head commit, so a
// missing analysis blocks the merge.

import { pathToFileURL } from "node:url";

const DOC_PATTERNS = [/^docs\//, /^protocol\//, /\.md$/i, /^LICENSE$/];

// Files release-please rewrites. Each is only trusted if the lines that changed are version lines.
const RELEASE_FILES = new Set([
  ".release-please-manifest.json",
  "package.json",
  "package-lock.json",
  "client/package.json",
  "server/package.json",
  "client/src-tauri/tauri.conf.json",
  "client/src-tauri/Cargo.toml",
  "charts/federated-chat-app/Chart.yaml",
]);

// A changed line that sets a version and nothing else: "version": "1.2.3", version = "1.2.3",
// version: 1.2.3, appVersion: "1.2.3", ".": "1.2.3" (the manifest). A dependency pin such as
// "left-pad": "1.3.0" deliberately does not match, and neither does a lockfile `resolved`/`integrity` line,
// which every real dependency change includes.
const VERSION_LINE = /^[+-]\s*(?:"(?:version|appVersion|\.)"|version|appVersion)\s*[:=]\s*"?v?\d+\.\d+\.\d+[\w.+-]*"?,?\s*$/;

export function isDocPath(path) {
  return DOC_PATTERNS.some((p) => p.test(path));
}

/** True when `patch` (a unified diff hunk) changes nothing but version lines. */
export function changesOnlyVersions(patch) {
  if (typeof patch !== "string" || patch.length === 0) return false; // too large or binary: not provable
  const changed = patch.split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
  return changed.length > 0 && changed.every((l) => VERSION_LINE.test(l));
}

function isReleaseChange(file) {
  if (file.previous_filename) return false;
  return RELEASE_FILES.has(file.filename) && changesOnlyVersions(file.patch);
}

/**
 * @param {{ event: string, files?: {filename: string, previous_filename?: string, patch?: string}[],
 *           headRef?: string, sameRepo?: boolean }} input
 * @returns {{ tier: "full" | "light" | "docs" | "push", reason: string }}
 */
export function classify({ event, files, headRef = "", sameRepo = false }) {
  if (event === "push") return { tier: "push", reason: "push to master: CodeQL only, the content was already tested in its pull request" };
  if (event !== "pull_request") return { tier: "full", reason: `${event}: running everything` };

  // GitHub lists at most 3000 files; an empty or maxed-out list is not something to build a skip on.
  if (!Array.isArray(files) || files.length === 0 || files.length >= 3000) {
    return { tier: "full", reason: "could not see the full list of changed files" };
  }

  // A rename moves a file out of one place into another, so judge both ends.
  const paths = files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  if (paths.every(isDocPath)) return { tier: "docs", reason: "only documentation changed" };

  if (sameRepo && headRef.startsWith("release-please--") && files.every((f) => (isDocPath(f.filename) && !f.previous_filename) || isReleaseChange(f))) {
    return { tier: "light", reason: "a release-please PR that only changes version numbers and the changelog" };
  }

  return { tier: "full", reason: "code or configuration changed" };
}

// --- command line (the `changes` job) ---------------------------------------------------------

async function main() {
  const { execFileSync } = await import("node:child_process");
  const { appendFileSync } = await import("node:fs");
  const event = process.env.EVENT_NAME ?? "";
  let result;
  try {
    let files;
    if (event === "pull_request") {
      const out = execFileSync(
        "gh",
        ["api", "--paginate", `repos/${process.env.REPO}/pulls/${process.env.PR_NUMBER}/files`, "--jq", ".[] | {filename, previous_filename, patch}"],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
      );
      files = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }
    result = classify({
      event,
      files,
      headRef: process.env.HEAD_REF ?? "",
      sameRepo: process.env.HEAD_REPO === process.env.REPO,
    });
  } catch (err) {
    // Anything unexpected means running everything, never skipping.
    result = { tier: "full", reason: `classifier failed (${err instanceof Error ? err.message : err}); running everything` };
  }
  console.log(`tier=${result.tier} (${result.reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tier=${result.tier}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**CI tier: \`${result.tier}\`** - ${result.reason}\n`);
}

// Only when run directly (the workflow), not when the tests import classify().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
