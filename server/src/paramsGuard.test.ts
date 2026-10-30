import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Express 5 types every path parameter as `string | string[]`, so `req.params.id` no longer type-checks where a string is wanted. Parameters
// are read through `param(req, "id")` (lib/params.ts), which makes the one decision in one place; a raw read would put back a cast or a
// guess at some route (#276). Only the helper itself may touch `req.params`.

const SRC = join(__dirname);
const RAW_READ = /\breq\.params\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("path parameters", () => {
  it("are read through param(), never as req.params", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.endsWith(join("lib", "params.ts")))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .flatMap((line, index) => (RAW_READ.test(line) ? [`${file.slice(SRC.length + 1)}:${index + 1}: ${line.trim()}`] : []))
      );
    expect(offenders).toEqual([]);
  });

  it("is able to see an offender (the guard itself works)", () => {
    expect(RAW_READ.test("const id = req.params.id;")).toBe(true);
    expect(RAW_READ.test('const id = param(req, "id");')).toBe(false);
  });
});
