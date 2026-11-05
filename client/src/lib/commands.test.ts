import { describe, expect, it } from "vitest";
import type { CommandOption, CommunityCommand } from "../api";
import { ApiError } from "../api/client";
import { buildOptions, commandFailure, commandQuery, initialValues, matchCommands, requiredFilled } from "./commands";

const opt = (over: Partial<CommandOption> & { name: string }): CommandOption => ({ description: "d", type: "string", required: false, ...over });
const cmd = (name: string): CommunityCommand => ({ id: name, name, description: "d", options: [], bot: { id: "b" } as never, botOnline: true });

describe("commandQuery (is a command being typed?)", () => {
  it("is what follows the / when the box starts with it and the caret is in the first word", () => {
    expect(commandQuery("/", 1)).toBe("");
    expect(commandQuery("/pi", 3)).toBe("pi");
    expect(commandQuery("/ping", 2)).toBe("ping"); // the caret in the middle of the word still means a command is being typed
  });

  it("is nothing for ordinary text, a slash that is not first, a slash with a space after the word, and a caret before the slash", () => {
    for (const [value, caret] of [["", 0], ["hello", 5], [" /ping", 6], ["see /ping", 9], ["/ping hello", 11], ["/ping ", 6], ["/a b", 1], ["/", 0], ["//", 0], ["a/b", 3], ["path/to", 7]] as [string, number][]) {
      expect(commandQuery(value, caret), `${JSON.stringify(value)} at ${caret}`).toBeNull();
    }
    expect(commandQuery("//path", 6)).toBe("/path"); // still the start of a word: it simply matches nothing
  });
});

describe("matchCommands", () => {
  const all = [cmd("request"), cmd("ping"), cmd("repeat"), cmd("reping")];

  it("lists names that start with what was typed first, then names that contain it, each in the order the server gave", () => {
    expect(matchCommands(all, "re").map((c) => c.name)).toEqual(["request", "repeat", "reping"]);
    expect(matchCommands(all, "ping").map((c) => c.name)).toEqual(["ping", "reping"]);
  });

  it("is every command for an empty query, ignores case, and is nothing when nothing matches", () => {
    expect(matchCommands(all, "")).toHaveLength(4);
    expect(matchCommands(all, "PI").map((c) => c.name)).toEqual(["ping", "reping"]);
    expect(matchCommands(all, "zzz")).toEqual([]);
  });
});

describe("the form's values", () => {
  const options = [opt({ name: "title", required: true }), opt({ name: "loud", type: "boolean" }), opt({ name: "count", type: "integer" })];

  it("start empty, and a boolean starts unticked", () => {
    expect(initialValues(options)).toEqual({ title: "", loud: false, count: "" });
  });

  it("let the button be pressed once every required option has something in it (a boolean always has)", () => {
    expect(requiredFilled(options, { title: "", loud: false, count: "" })).toBe(false);
    expect(requiredFilled(options, { title: "   ", loud: false, count: "" })).toBe(false);
    expect(requiredFilled(options, { title: "Dune", loud: false, count: "" })).toBe(true);
    expect(requiredFilled([opt({ name: "on", type: "boolean", required: true })], { on: false })).toBe(true);
  });
});

describe("buildOptions", () => {
  it("turns each value into its type, trims text, and leaves out an optional one that is empty or an unticked box", () => {
    const options = [
      opt({ name: "title", required: true }),
      opt({ name: "count", type: "integer" }),
      opt({ name: "ratio", type: "number" }),
      opt({ name: "loud", type: "boolean" }),
      opt({ name: "who", type: "member" }),
      opt({ name: "where", type: "channel" }),
      opt({ name: "skipped" }),
    ];
    expect(buildOptions(options, { title: "  Dune  ", count: " 3 ", ratio: "1.5", loud: true, who: "M1", where: "C1", skipped: "  " })).toEqual({
      ok: true,
      options: { title: "Dune", count: 3, ratio: 1.5, loud: true, who: "M1", where: "C1" },
    });
    expect(buildOptions(options, { title: "x", count: "", ratio: "", loud: false, who: "", where: "", skipped: "" })).toEqual({ ok: true, options: { title: "x" } });
  });

  it("names every problem at once, by option", () => {
    const options = [opt({ name: "title", required: true }), opt({ name: "count", type: "integer" }), opt({ name: "ratio", type: "number" })];
    const result = buildOptions(options, { title: " ", count: "1.5", ratio: "abc" });
    expect(result).toEqual({ ok: false, errors: { title: "Fill this in.", count: "Enter a whole number.", ratio: "Enter a number." } });
  });

  it("takes a whole number only as whole digits, and a number only when it is finite", () => {
    const count = [opt({ name: "n", type: "integer" })];
    for (const bad of ["1.5", "1e3", "0x10", "abc", "9999999999999999999", "--1"]) expect(buildOptions(count, { n: bad }).ok, bad).toBe(false);
    for (const good of ["0", "-7", "42"]) expect(buildOptions(count, { n: good }).ok, good).toBe(true);
    const ratio = [opt({ name: "r", type: "number" })];
    expect(buildOptions(ratio, { r: "Infinity" }).ok).toBe(false);
    expect(buildOptions(ratio, { r: "-0.25" })).toEqual({ ok: true, options: { r: -0.25 } });
  });

  it("turns a chosen value back into the choice's own value, a number staying a number, and refuses anything else", () => {
    const options = [
      opt({ name: "kind", choices: [{ name: "Film", value: "film" }, { name: "Show", value: "show" }] }),
      opt({ name: "level", type: "integer", choices: [{ name: "One", value: 1 }, { name: "Two", value: 2 }] }),
    ];
    expect(buildOptions(options, { kind: "show", level: "2" })).toEqual({ ok: true, options: { kind: "show", level: 2 } });
    expect(buildOptions(options, { kind: "documentary", level: "" })).toEqual({ ok: false, errors: { kind: "Choose one of the choices." } });
  });

  it("does not need a boolean, and a required one is fine unticked", () => {
    expect(buildOptions([opt({ name: "on", type: "boolean", required: true })], { on: false })).toEqual({ ok: true, options: {} });
  });
});

describe("commandFailure", () => {
  const say = (status: number, body: unknown) => commandFailure(new ApiError(status, body), "Robo");

  it("words each of the server's refusals, naming the bot where it matters", () => {
    expect(say(409, { error: "bot_offline" }).message).toBe("Robo is offline right now.");
    expect(say(429, { error: "bot_busy" }).message).toMatch(/Robo is busy/);
    expect(say(403, { error: "forbidden" }).message).toMatch(/can't run commands/);
    expect(say(404, { error: "not_found" }).message).toMatch(/isn't available any more/);
    expect(say(409, { error: "not_community_home" }).message).toMatch(/your own server/);
    expect(say(409, { error: "not_a_text_channel" }).message).toMatch(/text channel/);
  });

  it("names the option the server did not accept", () => {
    expect(say(400, { error: "invalid_options", option: "title" })).toEqual({ message: "That doesn't fit what the command asks for.", option: "title" });
    expect(say(400, { error: "invalid_options", option: "" })).toEqual({ message: "That doesn't fit what the command asks for." });
  });

  it("says slow down for a rate limit with no code, something went wrong for anything else, and could not reach for what is not an answer", () => {
    expect(say(429, undefined).message).toMatch(/too fast/);
    expect(say(500, undefined).message).toBe("Something went wrong. Try again.");
    expect(say(418, { error: "something_new" }).message).toBe("Something went wrong. Try again.");
    expect(commandFailure(new TypeError("network"), "Robo").message).toBe("Couldn't reach the server. Try again.");
  });
});
