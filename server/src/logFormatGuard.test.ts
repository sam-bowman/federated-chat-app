import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A log call whose FIRST argument is a template literal with a value from outside in it (a domain a user typed, the origin a peer
// claims, a username) makes that value part of the format string: a `%s` or `%d` in it is expanded by console, and CodeQL reports
// it as js/tainted-format-string (alert #100, which a change that began passing a caller's origin domain into the outbox surfaced).
// The value goes after a constant string instead: console.error("[federation] delivery to %s failed:", domain, err).
//
// This looks for the names that mean "came from outside" (`domain`, `origin`, `username`, `identity`, `input`), not for every
// interpolation: the server's own settings (`config.domain`, a port) are not user data.

const SRC = join(__dirname);
const FROM_OUTSIDE = /\b(domain|origin|username|identity|input|peer)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every console call whose first argument is a template literal, with the `${...}` expressions inside it. */
function templateLogCalls(text: string): { call: string; expressions: string[] }[] {
  const calls: { call: string; expressions: string[] }[] = [];
  for (const match of text.matchAll(/console\.(?:error|warn|log|info|debug)\(\s*`([^`]*)`/g)) {
    const expressions = [...match[1].matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
    calls.push({ call: match[0].replace(/\s+/g, " "), expressions });
  }
  return calls;
}

describe("log calls", () => {
  it("never build their format string from a value that came from outside", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const { call, expressions } of templateLogCalls(readFileSync(file, "utf8"))) {
        if (expressions.some((e) => !e.startsWith("config.") && FROM_OUTSIDE.test(e))) offenders.push(`${file.slice(SRC.length + 1)}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is able to see an offender (the guard itself works)", () => {
    const calls = templateLogCalls("console.error(`[federation] push to ${domain} failed:`, err); console.log(`on :${config.port}`);");

    expect(calls.map((c) => c.expressions)).toEqual([["domain"], ["config.port"]]);
    expect(calls[0].expressions.some((e) => FROM_OUTSIDE.test(e))).toBe(true);
    expect(calls[1].expressions.some((e) => !e.startsWith("config.") && FROM_OUTSIDE.test(e))).toBe(false);
  });
});
