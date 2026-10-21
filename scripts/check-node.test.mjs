import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KNOWN_BAD, knownBadNode } from "./check-node.mjs";

test("stops Node 24.15.0 on Windows, saying why and what to use instead", () => {
  const message = knownBadNode("v24.15.0", "win32");
  assert.ok(message);
  assert.match(message, /3221226505/);
  assert.match(message, /#211/);
  assert.match(message, /Node 22/);
  assert.match(message, /24\.16\.0/);
  assert.match(message, /ALLOW_KNOWN_BAD_NODE=1/);
});

test("lets everything else run: the neighbouring releases, other platforms, and the version CI uses", () => {
  for (const version of ["v24.14.1", "v24.16.0", "v24.22.0", "v22.23.3", "v22.0.0", "v25.9.0", "v24.15.1"]) {
    assert.equal(knownBadNode(version, "win32"), null, version);
  }
  for (const platform of ["linux", "darwin"]) assert.equal(knownBadNode("v24.15.0", platform), null, platform);
});

test("takes the version with or without the v, as process.version and npm give it", () => {
  assert.ok(knownBadNode("24.15.0", "win32"));
  assert.ok(knownBadNode("v24.15.0", "win32"));
});

test("can be overridden on purpose, and only by saying exactly 1", () => {
  assert.equal(knownBadNode("v24.15.0", "win32", { ALLOW_KNOWN_BAD_NODE: "1" }), null);
  for (const value of ["", "0", "true", "yes", undefined]) assert.ok(knownBadNode("v24.15.0", "win32", { ALLOW_KNOWN_BAD_NODE: value }), String(value));
});

test("only names releases that are really listed, each with its platform and an issue", () => {
  assert.ok(KNOWN_BAD.length > 0);
  for (const bad of KNOWN_BAD) {
    assert.match(bad.version, /^\d+\.\d+\.\d+$/u);
    assert.ok(bad.platform);
    assert.ok(bad.issue > 0);
  }
});

test("as a command it exits 0 and prints nothing when the override is set", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-node.mjs");
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, ALLOW_KNOWN_BAD_NODE: "1" } });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("as a command it exits 1 with the message when the Node is a bad one", () => {
  // Pretend to be the bad release without having it: the command reads process.version and process.platform, so run it with both faked.
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-node.mjs");
  const wrapper = `Object.defineProperty(process, "version", { value: "v24.15.0" }); Object.defineProperty(process, "platform", { value: "win32" }); process.argv[1] = ${JSON.stringify(script)}; await import(${JSON.stringify(new URL(`file:///${script.replace(/\\/g, "/")}`).href)});`;
  const env = { ...process.env };
  delete env.ALLOW_KNOWN_BAD_NODE;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", wrapper], { encoding: "utf8", env });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Node 24\.15\.0 on Windows crashes test runs/);
});
