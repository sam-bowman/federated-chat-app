// Judges ZAP's JSON reports (#250): lists every alert, and fails only on a HIGH risk alert that is not accepted in .github/zap/ignore.
// Used by dast.sh; the decision logic is pure so it can be tested (zap-report.test.mjs, run by the `lint` job in ci.yml).
//
//   node zap-report.mjs <report.json>...
//
// ZAP's own pass/fail is not used: its API scan marks every alert a WARN (or a FAIL only for rules named in a config file), which would
// make this check either always red or never red. Risk codes are ZAP's: 3 high, 2 medium, 1 low, 0 informational.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FAIL_AT = 3;
const RISK = { 3: "HIGH", 2: "Medium", 1: "Low", 0: "Info" };

/**
 * `.github/zap/ignore`: one ZAP rule id per line, `10038 exp:2027-01-31`, each with a reason in a comment above it. An entry past its
 * date is returned in `expired` and does NOT accept anything, so it comes back for a decision.
 */
export function parseIgnores(text, now = new Date()) {
  const accepted = new Set();
  const expired = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\d+)(?:\s+exp:(\d{4}-\d{2}-\d{2}))?\s*(?:#.*)?$/);
    if (!match) throw new Error(`cannot read the line "${line}" in the ZAP ignore file (expected: <rule id> exp:YYYY-MM-DD)`);
    const [, id, exp] = match;
    if (!exp) throw new Error(`rule ${id} in the ZAP ignore file has no expiry (exp:YYYY-MM-DD)`);
    if (new Date(`${exp}T23:59:59Z`) < now) expired.push({ id, exp });
    else accepted.add(id);
  }
  return { accepted, expired };
}

/** Every alert of every site of every report, reduced to what is worth showing. */
export function collectAlerts(reports) {
  const alerts = [];
  for (const report of reports) {
    for (const site of report.site ?? []) {
      for (const alert of site.alerts ?? []) {
        alerts.push({
          id: String(alert.pluginid),
          name: alert.name ?? alert.alert,
          risk: Number(alert.riskcode),
          count: Number(alert.count ?? alert.instances?.length ?? 0),
          examples: (alert.instances ?? []).slice(0, 3).map((i) => `${i.method ?? ""} ${String(i.uri ?? "").replace(/^https?:\/\/[^/]+/, "")}`.trim()),
        });
      }
    }
  }
  return alerts.sort((a, b) => b.risk - a.risk || a.name.localeCompare(b.name));
}

export function judge(reports, ignoreText = "", now = new Date()) {
  const { accepted, expired } = parseIgnores(ignoreText, now);
  const alerts = collectAlerts(reports);
  const failing = alerts.filter((a) => a.risk >= FAIL_AT && !accepted.has(a.id));
  return { alerts, failing, expired };
}

export function format({ alerts, failing, expired }) {
  const lines = [];
  if (alerts.length === 0) lines.push("ZAP reported nothing.");
  for (const a of alerts) lines.push(`${RISK[a.risk] ?? a.risk}\t[${a.id}] ${a.name} x ${a.count}${a.examples.length ? `\t${a.examples.join(", ")}` : ""}`);
  for (const e of expired) lines.push(`NOTE: the ignore entry for rule ${e.id} expired on ${e.exp}; it no longer accepts anything.`);
  lines.push(failing.length ? `FAIL: ${failing.length} HIGH risk alert(s) that are not accepted.` : "PASS: no HIGH risk alert that is not accepted.");
  return lines.join("\n");
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error("usage: zap-report.mjs <report.json>...");
  const reports = files.map((file) => {
    if (!existsSync(file)) throw new Error(`${file} was not written: the scan did not run to the end`);
    return JSON.parse(readFileSync(file, "utf8"));
  });
  const ignorePath = join(dirname(fileURLToPath(import.meta.url)), "..", "zap", "ignore");
  const result = judge(reports, existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "");
  const text = format(result);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ZAP\n\n\`\`\`\n${text}\n\`\`\`\n`);
  process.exit(result.failing.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
