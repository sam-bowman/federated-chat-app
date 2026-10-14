import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPackageVersion } from "./version.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "version-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readPackageVersion", () => {
  it("reads the version from package.json", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.2.3" }));
    expect(readPackageVersion(dir)).toBe("1.2.3");
  });

  it("returns null when there is no package.json", () => {
    expect(readPackageVersion(dir)).toBeNull();
  });

  it("returns null for invalid JSON, a missing version or a non-string version", () => {
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(readPackageVersion(dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(readPackageVersion(dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: 3 }));
    expect(readPackageVersion(dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "" }));
    expect(readPackageVersion(dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), "null");
    expect(readPackageVersion(dir)).toBeNull();
  });
});
