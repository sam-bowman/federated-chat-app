import { describe, expect, it } from "vitest";
import { COMMAND_LIMITS, checkOptions, parseCommands, storedOptions, type CommandOption } from "./botCommands.js";
import { interactionSnapshot, parseInteractionRef } from "./interactionRef.js";

const cmd = (over: Record<string, unknown> = {}) => ({ name: "request", description: "Ask for a film", ...over });
const opt = (over: Record<string, unknown> = {}) => ({ name: "title", description: "What to look for", type: "string", ...over });
const parse = (commands: unknown) => parseCommands({ commands });

describe("parseCommands (what a bot registers)", () => {
  it("accepts a good set and fills in what was left out", () => {
    const result = parse([cmd({ options: [opt({ required: true }), opt({ name: "kind", type: "string", choices: [{ name: "Film", value: "film" }, { name: "Show", value: "show" }] })] }), { name: "ping", description: "Pong" }]);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          name: "request",
          description: "Ask for a film",
          options: [
            { name: "title", description: "What to look for", type: "string", required: true },
            { name: "kind", description: "What to look for", type: "string", required: false, choices: [{ name: "Film", value: "film" }, { name: "Show", value: "show" }] },
          ],
        },
        { name: "ping", description: "Pong", options: [] },
      ],
    });
  });

  it("is not a set unless the body is { commands: [...] }", () => {
    for (const body of [undefined, null, "x", [], {}, { commands: "x" }, { commands: {} }]) expect(parseCommands(body).ok, JSON.stringify(body)).toBe(false);
    expect(parseCommands({ commands: [] })).toEqual({ ok: true, value: [] });
  });

  it("holds a bot to 50 commands, 10 options each and 25 choices", () => {
    expect(parse(Array.from({ length: 50 }, (_, i) => cmd({ name: `c${i}` }))).ok).toBe(true);
    expect(parse(Array.from({ length: 51 }, (_, i) => cmd({ name: `c${i}` }))).ok).toBe(false);
    const options = (n: number) => Array.from({ length: n }, (_, i) => opt({ name: `o${i}` }));
    expect(parse([cmd({ options: options(10) })]).ok).toBe(true);
    expect(parse([cmd({ options: options(11) })]).ok).toBe(false);
    const choices = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));
    expect(parse([cmd({ options: [opt({ choices: choices(25) })] })]).ok).toBe(true);
    expect(parse([cmd({ options: [opt({ choices: choices(26) })] })]).ok).toBe(false);
  });

  it("names the first thing wrong", () => {
    const detail = (commands: unknown) => {
      const r = parse(commands);
      return r.ok ? "" : r.detail;
    };
    expect(detail([cmd({ name: "Bad Name" })])).toMatch(/a command's name/);
    expect(detail([cmd(), cmd()])).toMatch(/command 'request': two commands have this name/);
    expect(detail([cmd({ description: "" })])).toMatch(/command 'request': the description must not be empty/);
    expect(detail([cmd({ description: "d".repeat(101) })])).toMatch(/longer than 100 characters/);
    expect(detail([cmd({ options: [opt({ type: "colour" })] })])).toMatch(/option 'title': the type must be one of/);
    expect(detail([cmd({ options: [opt(), opt()] })])).toMatch(/two options have this name/);
    expect(detail([cmd({ options: [opt({ name: "A" })] })])).toMatch(/an option's name/);
    expect(detail([cmd({ options: [opt({ required: "yes" })] })])).toMatch(/required must be true or false/);
  });

  it("makes required options come first, so a form and a bot never meet a gap", () => {
    expect(parse([cmd({ options: [opt({ name: "a", required: true }), opt({ name: "b" }), opt({ name: "c", required: true })] })])).toMatchObject({ ok: false, detail: expect.stringMatching(/required options must come before the optional ones/) });
    expect(parse([cmd({ options: [opt({ name: "a", required: true }), opt({ name: "b", required: true }), opt({ name: "c" })] })]).ok).toBe(true);
  });

  it("accepts choices only where they make sense, with values of the option's type and no repeats", () => {
    const withChoices = (type: string, choices: unknown) => parse([cmd({ options: [opt({ type, choices })] })]).ok;
    expect(withChoices("string", [{ name: "a", value: "x" }])).toBe(true);
    expect(withChoices("integer", [{ name: "a", value: 1 }, { name: "b", value: 2 }])).toBe(true);
    expect(withChoices("number", [{ name: "a", value: 1.5 }])).toBe(true);
    for (const type of ["boolean", "member", "channel"]) expect(withChoices(type, [{ name: "a", value: "x" }]), type).toBe(false);
    expect(withChoices("integer", [{ name: "a", value: 1.5 }])).toBe(false);
    expect(withChoices("integer", [{ name: "a", value: "1" }])).toBe(false);
    expect(withChoices("string", [{ name: "a", value: 1 }])).toBe(false);
    expect(withChoices("string", [{ name: "a", value: "x" }, { name: "b", value: "x" }])).toBe(false);
    expect(withChoices("string", [])).toBe(false);
    expect(withChoices("string", "nope")).toBe(false);
    expect(withChoices("string", [{ name: "", value: "x" }])).toBe(false);
  });

  it("cleans text (controls and direction overrides) and counts characters, not UTF-16 units", () => {
    const ok = parse([cmd({ description: "Ask‮ for\u0000 a film" })]);
    expect(ok).toMatchObject({ ok: true, value: [{ description: "Ask for a film" }] });
    expect(parse([cmd({ description: "😀".repeat(COMMAND_LIMITS.description) })]).ok).toBe(true);
    expect(parse([cmd({ description: "😀".repeat(COMMAND_LIMITS.description + 1) })]).ok).toBe(false);
  });

  it("does not take a command called __proto__ for anything but a name it refuses", () => {
    for (const name of ["__proto__", "-x", "_x"]) expect(parse([cmd({ name })]).ok, name).toBe(false);
    expect(parse([cmd({ options: [opt({ name: "__proto__" })] })]).ok).toBe(false);
  });
});

describe("storedOptions", () => {
  it("reads back what was stored, and nothing at all from what is not options", () => {
    const stored = [{ name: "title", description: "d", type: "string", required: true }];
    expect(storedOptions(stored)).toEqual(stored);
    for (const junk of [null, undefined, "x", 5, {}, [null], [{ name: "x" }]]) expect(storedOptions(junk), JSON.stringify(junk)).toEqual([]);
  });
});

describe("checkOptions (what a person enters)", () => {
  const options: CommandOption[] = [
    { name: "title", description: "d", type: "string", required: true },
    { name: "count", description: "d", type: "integer", required: false },
    { name: "ratio", description: "d", type: "number", required: false },
    { name: "loud", description: "d", type: "boolean", required: false },
    { name: "who", description: "d", type: "member", required: false },
    { name: "where", description: "d", type: "channel", required: false },
    { name: "kind", description: "d", type: "string", required: false, choices: [{ name: "Film", value: "film" }, { name: "Show", value: "show" }] },
    { name: "level", description: "d", type: "integer", required: false, choices: [{ name: "One", value: 1 }, { name: "Two", value: 2 }] },
  ];

  it("takes values of the right types", () => {
    expect(checkOptions(options, { title: "Dune", count: 3, ratio: 1.5, loud: true, who: "01HABC", where: "01HDEF", kind: "film", level: 2 })).toEqual({
      ok: true,
      values: { title: "Dune", count: 3, ratio: 1.5, loud: true, who: "01HABC", where: "01HDEF", kind: "film", level: 2 },
    });
  });

  it("needs the required ones, and treats leaving one out, null and an empty text for an optional one alike", () => {
    expect(checkOptions(options, {})).toEqual({ ok: false, option: "title" });
    expect(checkOptions(options, { title: "   " })).toEqual({ ok: false, option: "title" });
    expect(checkOptions(options, undefined)).toEqual({ ok: false, option: "title" });
    // An empty text for an optional option is the same as leaving it out, even one with choices.
    expect(checkOptions(options, { title: "Dune", count: null, kind: "" })).toEqual({ ok: true, values: { title: "Dune" } });
    expect(checkOptions([options[0], { ...options[6], choices: undefined }], { title: "Dune", kind: "  " })).toEqual({ ok: true, values: { title: "Dune" } });
  });

  it("refuses what is not of the type, naming the option", () => {
    const bad = (given: Record<string, unknown>) => checkOptions(options, { title: "Dune", ...given });
    expect(bad({ count: 1.5 })).toEqual({ ok: false, option: "count" });
    expect(bad({ count: "3" })).toEqual({ ok: false, option: "count" });
    expect(bad({ count: 2 ** 60 })).toEqual({ ok: false, option: "count" });
    expect(bad({ ratio: "1.5" })).toEqual({ ok: false, option: "ratio" });
    expect(bad({ ratio: Infinity })).toEqual({ ok: false, option: "ratio" });
    expect(bad({ loud: "true" })).toEqual({ ok: false, option: "loud" });
    expect(bad({ who: 5 })).toEqual({ ok: false, option: "who" });
    expect(bad({ who: "not an id!" })).toEqual({ ok: false, option: "who" });
    expect(bad({ where: "../etc" })).toEqual({ ok: false, option: "where" });
    expect(bad({ title: 5 })).toEqual({ ok: false, option: "title" });
    expect(bad({ title: ["Dune"] })).toEqual({ ok: false, option: "title" });
  });

  it("holds a choice option to its choices, strings and numbers alike", () => {
    expect(checkOptions(options, { title: "t", kind: "documentary" })).toEqual({ ok: false, option: "kind" });
    expect(checkOptions(options, { title: "t", level: 3 })).toEqual({ ok: false, option: "level" });
    expect(checkOptions(options, { title: "t", level: "1" })).toEqual({ ok: false, option: "level" });
  });

  it("refuses an entry for an option that does not exist, and anything that is not a set of entries", () => {
    expect(checkOptions(options, { title: "t", surprise: 1 })).toEqual({ ok: false, option: "surprise" });
    expect(checkOptions(options, JSON.parse('{"title":"t","__proto__":{"x":1}}'))).toEqual({ ok: false, option: "__proto__" });
    for (const given of ["x", 5, [], true]) expect(checkOptions(options, given).ok, JSON.stringify(given)).toBe(false);
  });

  it("cleans a text to one line and refuses one over the limit instead of cutting it", () => {
    expect(checkOptions(options, { title: "  Du‮ne \n  2021  " })).toEqual({ ok: true, values: { title: "Dune 2021" } });
    expect(checkOptions(options, { title: "x".repeat(COMMAND_LIMITS.string) }).ok).toBe(true);
    expect(checkOptions(options, { title: "x".repeat(COMMAND_LIMITS.string + 1) })).toEqual({ ok: false, option: "title" });
    expect(checkOptions(options, { title: "😀".repeat(COMMAND_LIMITS.string) }).ok).toBe(true);
    expect(checkOptions(options, { title: "x".repeat(100_000) })).toEqual({ ok: false, option: "title" });
  });

  it("has no options to enter for a command with none", () => {
    expect(checkOptions([], undefined)).toEqual({ ok: true, values: {} });
    expect(checkOptions([], {})).toEqual({ ok: true, values: {} });
    expect(checkOptions([], { x: 1 })).toEqual({ ok: false, option: "x" });
  });
});

describe("the reference a message keeps to the command it answers", () => {
  it("is a snapshot, read back as the command and who ran it", () => {
    const stored = interactionSnapshot({ id: "01HINT", command: "request", userId: "01HUSER", name: "Olive" });
    expect(stored).toEqual({ id: "01HINT", command: "request", userId: "01HUSER", name: "Olive" });
    expect(parseInteractionRef(stored)).toEqual({ id: "01HINT", command: "request", user: { id: "01HUSER", name: "Olive" } });
  });

  it("cleans the name and stands in for one that is nothing", () => {
    expect(interactionSnapshot({ id: "a", command: "x", userId: "u", name: "Ol‮ive\u0000" }).name).toBe("Olive");
    expect(interactionSnapshot({ id: "a", command: "x", userId: "u", name: "​" }).name).toBe("Someone");
  });

  it("is nothing for anything that is not one, and never throws", () => {
    for (const junk of [null, undefined, "x", 5, [], {}, { id: "a" }, { id: "a", command: "Bad Name", userId: "u", name: "n" }, { id: "a b", command: "x", userId: "u", name: "n" }, { id: "a", command: "x", userId: "u", name: "​" }, { id: 5, command: "x", userId: "u", name: "n" }]) {
      expect(parseInteractionRef(junk), JSON.stringify(junk)).toBeNull();
    }
  });
});
