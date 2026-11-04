// Property tests (fast-check) for splitStatements (#325). It cuts a migration.sql file into statements, and a wrong cut corrupts a migration
// silently: a semicolon inside a string, a quoted name, a dollar-quoted function body or a comment must NOT end a statement, and one outside
// them must. The hand-made cases come from the first of those bugs; these build SQL from pieces that each contain awkward semicolons and ask
// for exactly the statements that went in, then ask what must hold for ANY text. A failure prints the seed and the smallest input; write that
// input down as an ordinary case beside the others.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitStatements } from "./standaloneMigrate.js";

const noSpace = (text: string) => text.replace(/\s/gu, "");

// A piece of one statement. Every one may hold a semicolon, a quote or a dollar sign that means nothing where it is.
const plain = fc.stringMatching(/^[A-Za-z0-9_ ,()*=.]{1,12}$/u);
const inner = fc.stringMatching(/^[a-z ;$-]{0,12}$/u);
const singleQuoted = fc.array(inner, { minLength: 1, maxLength: 3 }).map((parts) => `'${parts.join("''")}'`);
const doubleQuoted = fc.stringMatching(/^[a-z ;$'-]{1,12}$/u).map((name) => `"${name}"`);
const dollarBody = fc.stringMatching(/^[a-zA-Z ;'"-]{0,20}$/u);
const dollarQuoted = fc.tuple(fc.constantFrom("", "fn", "body", "x1"), dollarBody).map(([tag, body]) => `$${tag}$${body}$${tag}$`);
const lineComment = fc.stringMatching(/^[a-z ;'"$]{0,16}$/u).map((text) => `-- ${text}\n`);
const piece = fc.oneof({ weight: 4, arbitrary: plain }, singleQuoted, doubleQuoted, dollarQuoted, lineComment);
const statement = fc
  .array(piece, { minLength: 1, maxLength: 6 })
  .map((pieces) => pieces.join(" "))
  .filter((text) => text.trim() !== "");

describe("splitStatements, for SQL built from awkward pieces", () => {
  it("returns exactly the statements that went in, however many semicolons are inside strings, names, bodies and comments", () => {
    fc.assert(
      fc.property(fc.array(statement, { minLength: 1, maxLength: 6 }), fc.constantFrom("\n", "\n\n", " \n"), (statements, glue) => {
        const sql = statements.map((s) => `${s};`).join(glue);
        const expected = statements.map((s) => `${s};`.trim());
        expect(splitStatements(sql)).toEqual(expected);
      }),
      { numRuns: 1000 }
    );
  });

  it("keeps a last statement that has no semicolon", () => {
    fc.assert(
      fc.property(fc.array(statement, { minLength: 1, maxLength: 4 }), statement, (statements, last) => {
        const sql = `${statements.map((s) => `${s};`).join("\n")}\n${last}`;
        expect(splitStatements(sql)).toEqual([...statements.map((s) => `${s};`.trim()), last.trim()]);
      }),
      { numRuns: 500 }
    );
  });
});

describe("splitStatements, for any text", () => {
  it("never throws, and keeps every character that is not white space, in order", () => {
    const SQL_ISH = ["'", '"', "$$", "$fn$", "$", ";", "--", "\n", " ", "''", "SELECT 1", "CREATE", "(", ")", "é", "😀"];
    const text = fc.array(fc.oneof(fc.constantFrom(...SQL_ISH), fc.string({ maxLength: 5 })), { maxLength: 40 }).map((p) => p.join(""));
    fc.assert(
      fc.property(text, (sql) => {
        const statements = splitStatements(sql);
        expect(noSpace(statements.join(""))).toBe(noSpace(sql));
        for (const s of statements) {
          expect(s).toBe(s.trim());
          expect(s).not.toBe("");
        }
      }),
      { numRuns: 1500 }
    );
  });

  it("takes time in proportion to the text, even for text made of what it looks for", () => {
    const started = Date.now();
    for (const piece of ["'", '"', "$", "$a$", "--", ";", "''", "$$ "]) splitStatements(piece.repeat(20000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
