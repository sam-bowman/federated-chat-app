// Run with `node --test .github/scripts/` (the `lint` job in ci.yml does).
// The shapes below are what cargo-audit 0.22.2 really printed: a clean run on client/src-tauri/Cargo.lock (five warnings and a yanked crate)
// and a run on a lockfile holding `time 0.1.43` (one vulnerability, exit status 1).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, judge, parseIgnores } from "./cargo-audit-report.mjs";

const NOW = new Date("2026-11-05T12:00:00Z");
const database = { "advisory-count": 1409, "last-commit": "26fd2d4", "last-updated": "2026-11-05T09:50:49+01:00" };
const pkg = (name, version) => ({ name, version, source: "registry+https://github.com/rust-lang/crates.io-index" });
const vulnerability = (id, name, version, patched = [">=0.2.23"]) => ({ advisory: { id, package: name, title: `a flaw in ${name}` }, package: pkg(name, version), versions: { patched, unaffected: [] } });
const warning = (kind, name, version, id, title) => ({ kind, package: pkg(name, version), advisory: id ? { id, title } : undefined });
const report = ({ list = [], warnings = {} } = {}) => ({ database, vulnerabilities: { found: list.length > 0, count: list.length, list }, warnings });

describe("what fails", () => {
  it("fails on a vulnerability", () => {
    const result = judge(report({ list: [vulnerability("RUSTSEC-2020-0071", "time", "0.1.43")] }), "", NOW);
    assert.deepEqual(result.failing.map((v) => v.id), ["RUSTSEC-2020-0071"]);
    assert.match(format(result), /FAIL: 1 vulnerability/);
  });

  it("does not fail on unmaintained, unsound or yanked crates, but lists them", () => {
    const result = judge(
      report({
        warnings: {
          unmaintained: [warning("unmaintained", "proc-macro-error", "1.0.4", "RUSTSEC-2024-0370", "proc-macro-error is unmaintained")],
          unsound: [warning("unsound", "glib", "0.18.5", "RUSTSEC-2024-0429", "Unsoundness in VariantStrIter")],
          yanked: [warning("yanked", "async-executor", "1.14.0")],
        },
      }),
      "",
      NOW
    );
    assert.equal(result.failing.length, 0);
    assert.deepEqual(result.warnings.map((w) => `${w.kind} ${w.crate}`), ["unmaintained proc-macro-error 1.0.4", "unsound glib 0.18.5", "yanked async-executor 1.14.0"]);
    const text = format(result);
    assert.match(text, /PASS: no vulnerability that is not accepted \(3 warning/);
    assert.match(text, /yanked\tasync-executor 1\.14\.0/); // a yanked crate has no advisory: listed without an id
    assert.match(text, /RUSTSEC-2024-0429/);
  });

  it("says what fixes a vulnerability, or that nothing does", () => {
    const text = format(judge(report({ list: [vulnerability("RUSTSEC-1", "a", "1.0.0", [">=1.1.0", ">=2.0.0"]), vulnerability("RUSTSEC-2", "b", "1.0.0", [])] }), "", NOW));
    assert.match(text, /a 1\.0\.0: .* \(fixed in >=1\.1\.0 or >=2\.0\.0\)/);
    assert.match(text, /b 1\.0\.0: .* \(no fix\)/);
  });

  it("is a clean pass when nothing was found", () => {
    const result = judge(report(), "", NOW);
    assert.equal(result.failing.length, 0);
    assert.match(format(result), /Checked against 1409 advisories\.\nPASS/);
  });

  it("refuses a report from a run that never read the advisory database, instead of calling it clean", () => {
    assert.throws(() => judge({}, "", NOW), /did not run to the end/);
    assert.throws(() => judge({ vulnerabilities: { found: false, count: 0, list: [] } }, "", NOW), /did not run to the end/);
    assert.throws(() => judge({ database: { "advisory-count": 0 }, vulnerabilities: { list: [] } }, "", NOW), /did not run to the end/);
    assert.throws(() => judge({ database }, "", NOW), /did not run to the end/);
  });
});

describe("accepting a vulnerability on purpose", () => {
  const found = report({ list: [vulnerability("RUSTSEC-2020-0071", "time", "0.1.43")] });

  it("lets an accepted advisory through until its date, and still shows it", () => {
    const result = judge(found, "# a reason\nRUSTSEC-2020-0071 exp:2026-12-31\n", NOW);
    assert.equal(result.failing.length, 0);
    assert.match(format(result), /RUSTSEC-2020-0071 time 0\.1\.43.*\taccepted/);
  });

  it("stops accepting it after its date, and says so", () => {
    const result = judge(found, "RUSTSEC-2020-0071 exp:2026-11-01", NOW);
    assert.equal(result.failing.length, 1);
    assert.deepEqual(result.expired, [{ id: "RUSTSEC-2020-0071", exp: "2026-11-01" }]);
    assert.match(format(result), /expired on 2026-11-01/);
  });

  it("accepts only the advisory it names", () => {
    const two = report({ list: [vulnerability("RUSTSEC-2020-0071", "time", "0.1.43"), vulnerability("RUSTSEC-2021-0001", "other", "1.0.0")] });
    assert.deepEqual(judge(two, "RUSTSEC-2020-0071 exp:2099-01-01", NOW).failing.map((v) => v.id), ["RUSTSEC-2021-0001"]);
  });

  it("refuses an entry without an expiry or one it cannot read, instead of ignoring it", () => {
    assert.throws(() => parseIgnores("RUSTSEC-2020-0071", NOW), /no expiry/);
    assert.throws(() => parseIgnores("time exp:2099-01-01", NOW), /cannot read/);
    assert.throws(() => parseIgnores("CVE-2020-1234 exp:2099-01-01", NOW), /cannot read/);
  });

  it("ignores comments and blank lines, and a trailing comment", () => {
    const { accepted } = parseIgnores("# reason\n\n  RUSTSEC-2020-0071 exp:2099-01-01  # why\n", NOW);
    assert.deepEqual([...accepted], ["RUSTSEC-2020-0071"]);
  });

  it("counts an entry as valid through the whole of its last day", () => {
    assert.equal(parseIgnores("RUSTSEC-2020-0071 exp:2026-11-05", NOW).accepted.size, 1);
    assert.equal(parseIgnores("RUSTSEC-2020-0071 exp:2026-11-04", NOW).accepted.size, 0);
  });
});

describe("the command the job runs", () => {
  const script = fileURLToPath(new URL("./cargo-audit-report.mjs", import.meta.url));
  const run = (content) => {
    const file = join(mkdtempSync(join(tmpdir(), "cargo-audit-")), "audit.json");
    if (content !== null) writeFileSync(file, content);
    return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  };

  it("exits 1 on a vulnerability that is not accepted, and says which", () => {
    const result = run(JSON.stringify(report({ list: [vulnerability("RUSTSEC-2020-0071", "time", "0.1.43")] })));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL/);
  });

  it("exits 0 on a clean run and when only warnings were found", () => {
    assert.equal(run(JSON.stringify(report())).status, 0);
    assert.equal(run(JSON.stringify(report({ warnings: { yanked: [warning("yanked", "async-executor", "1.14.0")] } }))).status, 0);
  });

  it("does not exit 0 when cargo audit left nothing usable", () => {
    assert.notEqual(run(null).status, 0);
    assert.notEqual(run("").status, 0);
    assert.notEqual(run("{}").status, 0);
  });
});
