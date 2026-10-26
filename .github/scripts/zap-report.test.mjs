// Run with `node --test .github/scripts/` (the `lint` job in ci.yml does).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectAlerts, format, judge, parseIgnores } from "./zap-report.mjs";
import { exampleFor, withExamples } from "./zap-seed.mjs";

const alert = (pluginid, riskcode, extra = {}) => ({ pluginid, name: `rule ${pluginid}`, riskcode: String(riskcode), count: "2", instances: [{ method: "GET", uri: "http://host:4000/api/v1/x" }], ...extra });
const report = (...alerts) => ({ site: [{ "@name": "http://host:4000", alerts }] });
const NOW = new Date("2026-10-22T12:00:00Z");

describe("what fails", () => {
  it("fails on a HIGH alert", () => {
    const result = judge([report(alert("40018", 3))], "", NOW);
    assert.deepEqual(result.failing.map((a) => a.id), ["40018"]);
  });

  it("does not fail on medium, low or informational alerts, but lists them", () => {
    const result = judge([report(alert("1", 2), alert("2", 1), alert("3", 0))], "", NOW);
    assert.equal(result.failing.length, 0);
    assert.equal(result.alerts.length, 3);
  });

  it("looks at every site of every report", () => {
    const two = [report(alert("1", 0)), { site: [{ alerts: [alert("2", 3)] }, { alerts: [alert("3", 3)] }] }];
    assert.deepEqual(judge(two, "", NOW).failing.map((a) => a.id).sort(), ["2", "3"]);
  });

  it("copes with a report that found nothing (no site at all)", () => {
    assert.equal(judge([{}], "", NOW).alerts.length, 0);
    assert.match(format(judge([{}], "", NOW)), /ZAP reported nothing/);
  });

  it("sorts the most serious first", () => {
    assert.deepEqual(collectAlerts([report(alert("1", 1), alert("2", 3), alert("3", 2))]).map((a) => a.id), ["2", "3", "1"]);
  });
});

describe("accepting an alert on purpose", () => {
  it("lets an accepted rule through until its date", () => {
    const text = "# a reason\n40018 exp:2026-12-31\n";
    assert.equal(judge([report(alert("40018", 3))], text, NOW).failing.length, 0);
  });

  it("stops accepting it after its date, and says so", () => {
    const result = judge([report(alert("40018", 3))], "40018 exp:2026-10-01", NOW);
    assert.equal(result.failing.length, 1);
    assert.deepEqual(result.expired, [{ id: "40018", exp: "2026-10-01" }]);
    assert.match(format(result), /expired on 2026-10-01/);
  });

  it("accepts only the rule it names", () => {
    assert.equal(judge([report(alert("40018", 3), alert("40012", 3))], "40018 exp:2099-01-01", NOW).failing.length, 1);
  });

  it("refuses an entry without an expiry or one it cannot read, instead of ignoring it", () => {
    assert.throws(() => parseIgnores("40018", NOW), /no expiry/);
    assert.throws(() => parseIgnores("everything exp:2099-01-01", NOW), /cannot read/);
  });

  it("ignores comments and blank lines", () => {
    assert.equal(parseIgnores("\n# only a comment\n\n", NOW).accepted.size, 0);
  });
});

describe("the examples written into the OpenAPI file", () => {
  const ids = { community: "COMM", channel: "CHAN", conversation: "CONV", message: "MSG", otherId: "OTHER", otherUsername: "dast_other" };

  it("pick the id by the resource and the name of the parameter", () => {
    assert.equal(exampleFor("communities", "id", ids), "COMM");
    assert.equal(exampleFor("communities", "channelId", ids), "CHAN");
    assert.equal(exampleFor("channels", "id", ids), "CHAN");
    assert.equal(exampleFor("messages", "id", ids), "MSG");
    assert.equal(exampleFor("users", "username", ids), "dast_other");
    assert.equal(exampleFor("admin", "id", ids), undefined);
  });

  it("are added to the parameter line, quoted paths included, and nothing else changes", () => {
    const spec = [
      "paths:",
      "  /communities/{id}:",
      "    get:",
      "      parameters:",
      "        - { name: id, in: path, required: true, schema: { type: string } }",
      '  "/messages/{id}":',
      "    get:",
      "      parameters:",
      "        - { name: id, in: path, required: true, schema: { type: string }, description: \"The message.\" }",
      "  /admin/users/{username}:",
      "    get:",
      "      parameters:",
      "        - { name: username, in: path, required: true, schema: { type: string } }",
    ].join("\n");
    const out = withExamples(spec, ids).split("\n");
    assert.equal(out[4], '        - { name: id, in: path, required: true, schema: { type: string }, example: "COMM" }');
    assert.equal(out[8], '        - { name: id, in: path, required: true, schema: { type: string }, description: "The message.", example: "MSG" }');
    assert.equal(out[12], "        - { name: username, in: path, required: true, schema: { type: string } }");
    assert.equal(out.length, 13);
  });

  it("are left out for an id that could not be made", () => {
    const line = "        - { name: id, in: path, required: true, schema: { type: string } }";
    assert.equal(withExamples(`  /communities/{id}:\n${line}`, {}).split("\n")[1], line);
  });
});
