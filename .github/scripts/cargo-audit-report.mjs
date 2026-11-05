// Judges `cargo audit --json` for the desktop app's Rust dependencies (client/src-tauri/Cargo.lock): lists everything it found and fails
// only on a VULNERABILITY that is not accepted in .github/cargo-audit/ignore. Used by cargo-audit.sh; the decision logic is pure so it can
// be tested (cargo-audit-report.test.mjs, run by the `lint` job in ci.yml).
//
//   node cargo-audit-report.mjs <audit.json>
//
// cargo-audit's own exit code is not used, because it cannot tell "found a vulnerability" from "could not run" and has no expiry on an
// accepted advisory. Its `warnings` are the other three kinds of advisory: `unmaintained` (nobody to fix it), `unsound` (a flaw in a
// way of using the crate) and `yanked` (the author withdrew that version). Those are listed, never failing: nearly all are in crates
// Tauri's own Linux layer brings in, and nothing here can change them until Tauri does.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * `.github/cargo-audit/ignore`: one advisory id per line, `RUSTSEC-2026-0001 exp:2027-01-31`, each with a reason in a comment above it.
 * An entry past its date is returned in `expired` and does NOT accept anything, so it comes back for a decision.
 */
export function parseIgnores(text, now = new Date()) {
  const accepted = new Set();
  const expired = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(RUSTSEC-\d{4}-\d{4})(?:\s+exp:(\d{4}-\d{2}-\d{2}))?\s*(?:#.*)?$/);
    if (!match) throw new Error(`cannot read the line "${line}" in the cargo-audit ignore file (expected: RUSTSEC-YYYY-NNNN exp:YYYY-MM-DD)`);
    const [, id, exp] = match;
    if (!exp) throw new Error(`${id} in the cargo-audit ignore file has no expiry (exp:YYYY-MM-DD)`);
    if (new Date(`${exp}T23:59:59Z`) < now) expired.push({ id, exp });
    else accepted.add(id);
  }
  return { accepted, expired };
}

const crate = (entry) => `${entry?.package?.name ?? "?"} ${entry?.package?.version ?? ""}`.trim();

/**
 * @param {unknown} report the parsed `cargo audit --json` output
 * @returns {{ vulnerabilities: object[], failing: object[], warnings: object[], expired: object[], advisories: number }}
 */
export function judge(report, ignoreText = "", now = new Date()) {
  // A run that did not get as far as reading the advisory database has no `vulnerabilities` and no advisory count: that is a scan that
  // tested nothing, and it must not look like a clean one.
  const found = report?.vulnerabilities?.list;
  const advisories = Number(report?.database?.["advisory-count"] ?? 0);
  if (!Array.isArray(found) || !(advisories > 0)) throw new Error("the report has no vulnerabilities list or no advisory database: cargo audit did not run to the end");

  const { accepted, expired } = parseIgnores(ignoreText, now);
  const vulnerabilities = found.map((v) => ({ id: String(v.advisory?.id ?? "?"), title: v.advisory?.title ?? "", crate: crate(v), patched: v.versions?.patched ?? [] }));
  const failing = vulnerabilities.filter((v) => !accepted.has(v.id));

  const warnings = Object.entries(report.warnings ?? {})
    .flatMap(([kind, entries]) => (Array.isArray(entries) ? entries : []).map((w) => ({ kind, id: w.advisory?.id ?? null, title: w.advisory?.title ?? "", crate: crate(w) })))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.crate.localeCompare(b.crate));
  return { vulnerabilities, failing, warnings, expired, advisories };
}

export function format({ vulnerabilities, failing, warnings, expired, advisories }) {
  const lines = [`Checked against ${advisories} advisories.`];
  for (const v of vulnerabilities) {
    const patched = v.patched.length ? ` (fixed in ${v.patched.join(" or ")})` : " (no fix)";
    lines.push(`VULNERABILITY\t${v.id} ${v.crate}: ${v.title}${patched}${failing.includes(v) ? "" : "\taccepted"}`);
  }
  for (const w of warnings) lines.push(`${w.kind}\t${w.crate}${w.id ? ` ${w.id}` : ""}${w.title ? `: ${w.title}` : ""}`);
  for (const e of expired) lines.push(`NOTE: the ignore entry for ${e.id} expired on ${e.exp}; it no longer accepts anything.`);
  lines.push(failing.length ? `FAIL: ${failing.length} vulnerability(ies) that are not accepted.` : `PASS: no vulnerability that is not accepted (${warnings.length} warning(s), listed above, do not fail).`);
  return lines.join("\n");
}

function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: cargo-audit-report.mjs <audit.json>");
  if (!existsSync(file)) throw new Error(`${file} was not written: cargo audit did not run to the end`);
  const ignorePath = join(dirname(fileURLToPath(import.meta.url)), "..", "cargo-audit", "ignore");
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not JSON: cargo audit did not run to the end`);
  }
  const result = judge(report, existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "");
  const text = format(result);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Rust dependencies (cargo audit)\n\n\`\`\`\n${text}\n\`\`\`\n`);
  process.exit(result.failing.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
