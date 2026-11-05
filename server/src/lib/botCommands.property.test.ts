import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COMMAND_LIMITS, OPTION_TYPES, checkOptions, parseCommands, type CommandOption } from "./botCommands.js";

// What must hold for ANY registration a bot sends and ANY entries a person types: strangers' input. The generators build the awkward cases on
// purpose (bidi overrides, control characters, too many options, required after optional, numbers that are not whole, prototype keys).

const unsafe = fc.constantFrom("‮", "\u0000", "​", " ", "\r");
const text = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: "binary", maxLength: 40 }),
  fc.array(fc.oneof(fc.string({ maxLength: 8 }), unsafe), { maxLength: 12 }).map((p) => p.join("")),
  fc.string({ size: "max", maxLength: 3000 }),
  fc.constantFrom("", "   ", "__proto__", "constructor", "a".repeat(40), "😀".repeat(120))
);
const name = fc.oneof(fc.constantFrom("ping", "request", "a-b_c", "x"), text);
const anything = fc.oneof(text, fc.integer(), fc.double(), fc.boolean(), fc.constant(null), fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }), fc.dictionary(fc.string({ maxLength: 4 }), fc.string({ maxLength: 4 }), { maxKeys: 3 }));
const choice = fc.oneof(fc.record({ name: text, value: anything }, { requiredKeys: [] }), anything);
const option = fc.oneof(
  fc.record(
    {
      name,
      description: text,
      type: fc.oneof(fc.constantFrom(...OPTION_TYPES), anything),
      required: fc.oneof(fc.boolean(), anything),
      choices: fc.oneof(fc.array(choice, { maxLength: 30, size: "max" }), anything),
    },
    { requiredKeys: [] }
  ),
  anything
);
const command = fc.oneof(
  fc.record({ name, description: text, options: fc.oneof(fc.array(option, { maxLength: 14, size: "max" }), anything) }, { requiredKeys: [] }),
  anything
);
const body = fc.oneof(fc.record({ commands: fc.oneof(fc.array(command, { maxLength: 60, size: "max" }), anything) }), anything);

describe("parseCommands, for any body", () => {
  it("never throws, and what it accepts obeys every rule", () => {
    fc.assert(
      fc.property(body, (input) => {
        const result = parseCommands(input);
        if (!result.ok) {
          expect(typeof result.detail).toBe("string");
          return;
        }
        expect(result.value.length).toBeLessThanOrEqual(COMMAND_LIMITS.commands);
        expect(new Set(result.value.map((c) => c.name)).size).toBe(result.value.length);
        for (const c of result.value) {
          expect(c.name).toMatch(/^[a-z0-9][a-z0-9_-]{0,31}$/);
          expect(c.description).not.toBe("");
          expect([...c.description].length).toBeLessThanOrEqual(COMMAND_LIMITS.description);
          expect(c.options.length).toBeLessThanOrEqual(COMMAND_LIMITS.options);
          expect(new Set(c.options.map((o) => o.name)).size).toBe(c.options.length);
          const firstOptional = c.options.findIndex((o) => !o.required);
          if (firstOptional >= 0) expect(c.options.slice(firstOptional).every((o) => !o.required)).toBe(true);
          for (const o of c.options) {
            expect(OPTION_TYPES).toContain(o.type);
            expect(o.name).toMatch(/^[a-z0-9][a-z0-9_-]{0,31}$/);
            if (o.choices) {
              expect(["string", "integer", "number"]).toContain(o.type);
              expect(o.choices.length).toBeGreaterThan(0);
              expect(o.choices.length).toBeLessThanOrEqual(COMMAND_LIMITS.choices);
              for (const ch of o.choices) {
                if (o.type === "string") expect(typeof ch.value).toBe("string");
                else expect(typeof ch.value).toBe("number");
                if (o.type === "integer") expect(Number.isSafeInteger(ch.value)).toBe(true);
              }
            }
          }
        }
      }),
      { numRuns: 400 }
    );
  });

  it("is idempotent: registering what it accepted again accepts it unchanged", () => {
    fc.assert(
      fc.property(body, (input) => {
        const first = parseCommands(input);
        if (!first.ok) return;
        expect(parseCommands(JSON.parse(JSON.stringify({ commands: first.value })))).toEqual(first);
      }),
      { numRuns: 300 }
    );
  });
});

const options: CommandOption[] = [
  { name: "title", description: "d", type: "string", required: true },
  { name: "count", description: "d", type: "integer", required: false },
  { name: "ratio", description: "d", type: "number", required: false },
  { name: "loud", description: "d", type: "boolean", required: false },
  { name: "who", description: "d", type: "member", required: false },
  { name: "kind", description: "d", type: "string", required: false, choices: [{ name: "Film", value: "film" }, { name: "Show", value: "show" }] },
];
const entries = fc.oneof(
  fc.record({ title: anything, count: anything, ratio: anything, loud: anything, who: anything, kind: anything, extra: anything }, { requiredKeys: [] }),
  fc.dictionary(fc.oneof(fc.constantFrom("title", "count", "__proto__", "constructor"), text), anything, { maxKeys: 6 }),
  anything
);

describe("checkOptions, for any entries", () => {
  it("never throws, and what it accepts is of the registered types", () => {
    fc.assert(
      fc.property(entries, (given) => {
        const result = checkOptions(options, given);
        if (!result.ok) {
          expect(typeof result.option).toBe("string");
          return;
        }
        const { values } = result;
        expect(typeof values.title).toBe("string");
        expect(Object.keys(values).every((k) => options.some((o) => o.name === k))).toBe(true);
        if ("count" in values) expect(Number.isSafeInteger(values.count)).toBe(true);
        if ("ratio" in values) expect(Number.isFinite(values.ratio)).toBe(true);
        if ("loud" in values) expect(typeof values.loud).toBe("boolean");
        if ("who" in values) expect(values.who).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        if ("kind" in values) expect(["film", "show"]).toContain(values.kind);
        expect([...String(values.title)].length).toBeLessThanOrEqual(COMMAND_LIMITS.string);
        expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(String(values.title))).toBe(false);
        // What was accepted is accepted again as it stands.
        expect(checkOptions(options, JSON.parse(JSON.stringify(values)))).toEqual(result);
      }),
      { numRuns: 500 }
    );
  });
});
